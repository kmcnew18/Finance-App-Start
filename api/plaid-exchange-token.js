// /api/plaid-exchange-token.js
//
// Called once Plaid Link succeeds in the browser. Exchanges the short-lived
// public_token for a permanent access_token (must happen server-side —
// access_tokens are sensitive and should never reach the browser), stores
// that access_token against the user in Supabase, then immediately pulls
// balances for every account at that institution and writes them into
// linked_accounts so they show up right away.
//
// Requires: npm install plaid @supabase/supabase-js
//
// Required environment variables:
//   PLAID_CLIENT_ID
//   PLAID_SECRET
//   PLAID_ENV
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   — the SERVICE ROLE key (not the anon key).
//     This is required because this function writes rows on the user's
//     behalf from a trusted server context and needs to bypass RLS to do
//     so safely. Keep this key server-side only, exactly like PLAID_SECRET
//     — never expose it in any client-side file.

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
const { encryptToken } = require('../lib/crypto-helpers');
const { mapAccountType, storeTransactions, startOfPreviousMonth } = require('../lib/plaid-helpers');

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
    const { userId, publicToken, institutionName, selectedPlaidAccountIds } = req.body || {};
    if (!userId || !publicToken) {
      res.status(400).json({ error: 'Missing userId or publicToken' });
      return;
    }

    // Exchange the public_token for a permanent access_token + item_id.
    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    // Store the item so it can be re-synced later (see plaid-sync-accounts.js).
    // The access_token is encrypted before it ever touches the database —
    // accessToken itself (plaintext) stays in memory only for the rest of
    // this request, to make the immediate balance/sync calls below.
    const { error: itemError } = await supabaseAdmin
      .from('plaid_items')
      .insert({
        user_id: userId,
        item_id: itemId,
        access_token: encryptToken(accessToken),
        institution_name: institutionName || 'Bank',
      });
    if (itemError) throw itemError;

    await supabaseAdmin.from('audit_log').insert({
      user_id: userId,
      event_type: 'plaid_item_linked',
      detail: { item_id: itemId, institution_name: institutionName || 'Bank' },
    });

    // Pull balances immediately so the new accounts show up right away.
    const balancesRes = await plaidClient.accountsBalanceGet({ access_token: accessToken });
    let plaidAccounts = balancesRes.data.accounts || [];

    // If the person checked specific accounts in Arko's own picker
    // (rather than accepting everything the institution returned),
    // only those get linked. selectedPlaidAccountIds being omitted or
    // empty means "no selection was made" (older callers, or an
    // institution where Link itself already narrowed it down) — in
    // that case every returned account still gets linked, same as
    // before this existed.
    if (Array.isArray(selectedPlaidAccountIds) && selectedPlaidAccountIds.length) {
      const selectedSet = new Set(selectedPlaidAccountIds);
      plaidAccounts = plaidAccounts.filter(a => selectedSet.has(a.account_id));
    }

    const rows = plaidAccounts.map(a => ({
      user_id: userId,
      institution_name: institutionName || 'Bank',
      nickname: a.name || a.official_name || null,
      account_type: mapAccountType(a.type, a.subtype),
      balance: Math.abs(a.balances.current ?? a.balances.available ?? 0),
      source: 'plaid',
      plaid_item_id: itemId,
      plaid_account_id: a.account_id,
    }));

    let insertedAccountIds = [];
    if (rows.length) {
      const { data: insertedRows, error: acctError } = await supabaseAdmin.from('linked_accounts').insert(rows).select('id');
      if (acctError) throw acctError;
      insertedAccountIds = (insertedRows || []).map(r => r.id);
    }

    // Transactions/webhooks won't start firing for this item until
    // /transactions/sync has been called on it at least once — Plaid's
    // docs are explicit about this. This loops through every page
    // (has_more) since Plaid's historical backlog often spans multiple
    // pages — stopping after the first would leave the cursor partway
    // through history, and the *next* real sync (via webhook) would
    // then pick up the leftover page and treat old activity as new.
    //
    // Unlike before, this now actually stores what it finds — but only
    // a bounded window (the previous calendar month onward, so
    // "this month + last month"), and only into the transactions table
    // that feeds Spendings. It deliberately does NOT queue any of this
    // for Dashboard's review — Dashboard only ever suggests genuinely
    // new activity from the moment of connecting forward; this initial
    // batch is purely historical backfill for Spendings' charts. The
    // frontend uses the counts returned here to ask whether to keep or
    // remove that backfill before continuing.
    let historicalImport = { count: 0, windowStart: null };
    try {
      const connectedDate = new Date().toISOString().slice(0, 10);
      const storageCutoff = startOfPreviousMonth(connectedDate);
      const eligibleAccountIds = new Set(
        rows.filter(r => r.account_type === 'checking' || r.account_type === 'credit_card').map(r => r.plaid_account_id)
      );

      let cursor = undefined;
      let hasMore = true;
      let pageCount = 0;
      const collected = [];
      while (hasMore) {
        const syncRes = await plaidClient.transactionsSync({ access_token: accessToken, cursor });
        for (const txn of syncRes.data.added || []) {
          if (txn.date >= storageCutoff && eligibleAccountIds.has(txn.account_id)) collected.push(txn);
        }
        cursor = syncRes.data.next_cursor;
        hasMore = syncRes.data.has_more;
        pageCount++;
        if (pageCount > 50) break; // safety valve — should never realistically hit this
      }

      if (collected.length) {
        await storeTransactions(userId, collected, [], []);
      }
      historicalImport = { count: collected.length, windowStart: storageCutoff };

      await supabaseAdmin
        .from('plaid_items')
        .update({ transactions_cursor: cursor })
        .eq('item_id', itemId);
    } catch (syncErr) {
      // Not fatal — balances are already saved above. Transactions/
      // Recurring Transactions just won't be available for this item until
      // a later sync succeeds (e.g. via the webhook once data is ready).
      console.error('Initial transactions catch-up failed (non-fatal):', syncErr?.response?.data || syncErr);
    }

    res.status(200).json({
      success: true,
      accountsAdded: rows.length,
      itemId,
      linkedAccountIds: insertedAccountIds,
      historicalImport,
    });
  } catch (err) {
    console.error('plaid-exchange-token error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not finish linking this account' });
  }
};