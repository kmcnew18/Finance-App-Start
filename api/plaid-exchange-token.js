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
const { mapAccountType } = require('../lib/plaid-helpers');

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
    const { userId, publicToken, institutionName } = req.body || {};
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
    const plaidAccounts = balancesRes.data.accounts || [];

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

    if (rows.length) {
      const { error: acctError } = await supabaseAdmin.from('linked_accounts').insert(rows);
      if (acctError) throw acctError;
    }

    // Transactions/webhooks won't start firing for this item until
    // /transactions/sync has been called on it at least once — Plaid's docs
    // are explicit about this. Deliberately not storing any of what comes
    // back here: the whole point of this call is to catch the cursor up
    // past all of Plaid's historical backlog for this account, so nothing
    // that happened before the moment of connecting ever gets treated as
    // a "new" transaction by a later sync. Only real, ongoing activity
    // going forward gets processed once this fast-forward is done.
    //
    // Critically, this loops through every page (has_more) rather than
    // calling sync just once — Plaid's historical backlog often spans
    // multiple pages, and stopping after the first one would leave the
    // cursor partway through history. The *next* real sync (via webhook)
    // would then pick up that leftover historical page and process it as
    // if it were new activity — which is exactly what caused old,
    // seemingly-random transactions to show up in reviews after the fact.
    try {
      let cursor = undefined;
      let hasMore = true;
      let pageCount = 0;
      while (hasMore) {
        const syncRes = await plaidClient.transactionsSync({ access_token: accessToken, cursor });
        cursor = syncRes.data.next_cursor;
        hasMore = syncRes.data.has_more;
        pageCount++;
        if (pageCount > 50) break; // safety valve — should never realistically hit this
      }
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

    res.status(200).json({ success: true, accountsAdded: rows.length });
  } catch (err) {
    console.error('plaid-exchange-token error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not finish linking this account' });
  }
};