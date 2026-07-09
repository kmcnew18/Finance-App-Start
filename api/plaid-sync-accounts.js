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
const { decryptToken } = require('./_crypto-helpers');

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

    let updatedCount = 0;
    let flaggedCount = 0;

    for (const item of items || []) {
      try {
        const balancesRes = await plaidClient.accountsBalanceGet({ access_token: decryptToken(item.access_token) });
        const plaidAccounts = balancesRes.data.accounts || [];

        for (const a of plaidAccounts) {
          const { error: updateError } = await supabaseAdmin
            .from('linked_accounts')
            .update({
              balance: Math.abs(a.balances.current ?? a.balances.available ?? 0),
              updated_at: new Date().toISOString(),
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

    res.status(200).json({ success: true, updatedCount, flaggedCount });
  } catch (err) {
    console.error('plaid-sync-accounts error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not sync accounts' });
  }
};
