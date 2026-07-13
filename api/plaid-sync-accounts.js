// /api/plaid-sync-accounts.js
//
// Re-fetches current balances for every Plaid item a user has connected,
// and updates the matching rows in linked_accounts. Called by the
// "Sync all accounts" button in Settings, and safe to also run on a
// schedule (cron) later if you want balances to refresh automatically.
//
// Requires: npm install plaid @supabase/supabase-js
// Same environment variables as plaid-exchange-token.js.

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
const { decryptToken } = require('../lib/crypto-helpers');

const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
}));

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Investments is an optional Plaid product — most items won't have it,
// so a failure here is expected and normal, not an error worth
// surfacing. Only real Plaid errors (not "this item doesn't support
// this product") get logged.
async function syncHoldingsForItem(item, userId) {
  try {
    const holdingsRes = await plaidClient.investmentsHoldingsGet({ access_token: decryptToken(item.access_token) });
    const { accounts, holdings, securities } = holdingsRes.data;
    if (!holdings || !holdings.length) return 0;

    // Security master data — shared across users, upserted opportunistically.
    for (const s of securities || []) {
      await supabaseAdmin.from('investment_securities').upsert({
        security_id: s.security_id,
        ticker_symbol: s.ticker_symbol || null,
        name: s.name || null,
        security_type: s.type || null,
        logo_url: s.logo_url || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'security_id' });
    }

    // Map Plaid's account_id back to our own linked_accounts row —
    // holdings reference accounts by Plaid's id, not ours.
    const { data: linkedAccts } = await supabaseAdmin
      .from('linked_accounts')
      .select('id, plaid_account_id')
      .eq('user_id', userId)
      .in('plaid_account_id', (accounts || []).map(a => a.account_id));
    const accountIdByPlaidId = Object.fromEntries((linkedAccts || []).map(a => [a.plaid_account_id, a.id]));

    let holdingsSynced = 0;
    for (const h of holdings) {
      const linkedAccountId = accountIdByPlaidId[h.account_id];
      if (!linkedAccountId) continue;
      const { error } = await supabaseAdmin.from('investment_holdings').upsert({
        user_id: userId,
        linked_account_id: linkedAccountId,
        security_id: h.security_id,
        quantity: h.quantity || 0,
        institution_value: h.institution_value || 0,
        cost_basis: h.cost_basis ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'linked_account_id,security_id' });
      if (!error) holdingsSynced++;
    }
    return holdingsSynced;
  } catch (err) {
    const errorCode = err?.response?.data?.error_code;
    if (errorCode !== 'PRODUCTS_NOT_SUPPORTED' && errorCode !== 'PRODUCT_NOT_READY' && errorCode !== 'INVALID_PRODUCT') {
      console.error('Holdings sync failed for item', item.item_id, err?.response?.data || err);
    }
    return 0;
  }
}

async function recordPortfolioSnapshot(userId) {
  const { data: holdings } = await supabaseAdmin.from('investment_holdings').select('institution_value').eq('user_id', userId);
  if (!holdings || !holdings.length) return;
  const totalValue = holdings.reduce((s, h) => s + (Number(h.institution_value) || 0), 0);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: process.env.APP_TIMEZONE || 'America/Chicago' });
  await supabaseAdmin.from('investment_portfolio_snapshots').upsert({
    user_id: userId, snapshot_date: todayStr, total_value: Math.round(totalValue * 100) / 100,
  }, { onConflict: 'user_id,snapshot_date' });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { userId } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    const { data: items, error: itemsError } = await supabaseAdmin
      .from('plaid_items')
      .select('*')
      .eq('user_id', userId);
    if (itemsError) throw itemsError;

    const { data: linkedAccounts } = await supabaseAdmin
      .from('linked_accounts')
      .select('plaid_item_id')
      .eq('user_id', userId);
    const activeItemIds = new Set((linkedAccounts || []).map(a => a.plaid_item_id).filter(Boolean));

    let updatedCount = 0;
    let flaggedCount = 0;
    let orphansCleaned = 0;
    let holdingsCount = 0;

    for (const item of items || []) {
      // Same cleanup as plaid-sync-recurring.js — a plaid_items row with
      // no linked_accounts referencing it is left over from an account
      // removal that didn't fully complete in the background. Syncing it
      // anyway would just waste a Plaid call and could report a nonzero
      // updatedCount without actually updating any account the user can
      // see, which is more confusing than just finishing the cleanup.
      if (!activeItemIds.has(item.item_id)) {
        try {
          await plaidClient.itemRemove({ access_token: decryptToken(item.access_token) });
        } catch (plaidErr) {
          console.error('Orphaned item Plaid revocation failed (proceeding with local cleanup anyway):', item.item_id, plaidErr?.response?.data || plaidErr);
        }
        await supabaseAdmin.from('recurring_streams').delete().eq('plaid_item_id', item.item_id).eq('user_id', userId);
        await supabaseAdmin.from('plaid_items').delete().eq('item_id', item.item_id).eq('user_id', userId);
        orphansCleaned++;
        continue;
      }

      try {
        const balancesRes = await plaidClient.accountsBalanceGet({ access_token: decryptToken(item.access_token) });
        const plaidAccounts = balancesRes.data.accounts || [];

        for (const a of plaidAccounts) {
          const { error: updateError } = await supabaseAdmin
            .from('linked_accounts')
            .update({
              balance: Math.abs(a.balances.current ?? a.balances.available ?? 0),
              updated_at: new Date().toISOString(),
              last_synced_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
            .eq('plaid_account_id', a.account_id);
          if (!updateError) updatedCount++;
        }

        // A successful sync means this Item is healthy — clear any
        // stale reconnect flag from a previous failure.
        if (item.needs_reconnect) {
          await supabaseAdmin.from('plaid_items').update({ needs_reconnect: false, reconnect_reason: null }).eq('item_id', item.item_id);
        }

        holdingsCount += await syncHoldingsForItem(item, userId);
      } catch (perItemErr) {
        // One bad/expired item (e.g. user changed their bank password and
        // needs to re-link) shouldn't block syncing everything else — but
        // it should get flagged so the user can actually fix it, rather
        // than balances just silently going stale forever.
        const errorCode = perItemErr?.response?.data?.error_code;
        if (errorCode === 'ITEM_LOGIN_REQUIRED' || errorCode === 'ITEM_LOGIN_REQUIRED_FOR_TRANSFER') {
          await supabaseAdmin.from('plaid_items').update({
            needs_reconnect: true,
            reconnect_reason: 'Your bank requires you to sign in again to keep this connection active.',
          }).eq('item_id', item.item_id);
          flaggedCount++;
        }
        console.error('Sync failed for item', item.item_id, perItemErr?.response?.data || perItemErr);
      }
    }

    if (holdingsCount > 0) await recordPortfolioSnapshot(userId);

    console.log('plaid-sync-accounts result:', { userId, updatedCount, flaggedCount, orphansCleaned, holdingsCount });
    res.status(200).json({ success: true, updatedCount, flaggedCount, orphansCleaned, holdingsCount });
  } catch (err) {
    console.error('plaid-sync-accounts error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not sync accounts' });
  }
};