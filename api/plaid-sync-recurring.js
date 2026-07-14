// /api/plaid-sync-recurring.js
//
// Manually runs part or all of the same pipeline the webhook runs
// automatically. Accepts a `mode` of 'transactions' or 'subscriptions'
// to run only that half — used by the two separate "Refresh
// transactions" / "Refresh subscriptions" buttons, so neither one
// triggers the other. Omitting mode runs both, for anything that still
// wants the old combined behavior. 'deep-refresh' runs the combined
// sync too, then also backfills anything that was stored but somehow
// never made it into the review queue, and dedupes whatever's
// currently pending — used by Dashboard's "Refresh detected activity."
//
// Requires: npm install plaid @supabase/supabase-js

const { supabaseAdmin, processItemUpdate, refreshTransactionsForItem, refreshSubscriptionsForItem, backfillDashboardReviews, dedupeDashboardReviews, reclassifyPendingReviews, reclassifyStoredTransactions } = require('../lib/plaid-helpers');
const { decryptToken } = require('../lib/crypto-helpers');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
}));

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { userId, mode } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    // Verify the caller is actually authenticated as this user
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Missing authorization token' });
      return;
    }
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user || authData.user.id !== userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { data: items, error } = await supabaseAdmin
      .from('plaid_items')
      .select('*')
      .eq('user_id', userId);
    if (error) throw error;

    const { data: linkedAccounts } = await supabaseAdmin
      .from('linked_accounts')
      .select('plaid_item_id')
      .eq('user_id', userId);
    const activeItemIds = new Set((linkedAccounts || []).map(a => a.plaid_item_id).filter(Boolean));

    let totalAdded = 0;
    let totalQueued = 0;
    let orphansCleaned = 0;

    for (const item of items || []) {
      // A plaid_items row with no linked_accounts pointing at it is a
      // leftover from an account removal that didn't fully complete —
      // that revocation is a background, fire-and-forget call from the
      // client, so it's not guaranteed to finish (a network hiccup, the
      // tab closing, an old incompatible token, etc. can all leave this
      // behind even though the account looks fully gone in Connections,
      // since that page only reads linked_accounts, a separate table).
      // Rather than sync a connection nothing references anymore — which
      // is exactly what was making already-cleared subscriptions
      // reappear on every refresh — finish the cleanup properly here and
      // move on.
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
        if (mode === 'transactions') {
          const result = await refreshTransactionsForItem(item);
          totalAdded += result.addedCount;
        } else if (mode === 'subscriptions') {
          const result = await refreshSubscriptionsForItem(item);
          totalQueued += result.queuedCount;
        } else {
          // Both 'deep-refresh' and the default (no mode) run the same
          // combined per-item sync — deep-refresh's extra work
          // (backfill + dedupe) happens once, after this loop, since
          // those are user-level operations rather than per-item ones.
          const result = await processItemUpdate(item);
          totalAdded += result.addedCount;
          totalQueued += result.queuedCount;
        }
      } catch (perItemErr) {
        console.error('Sync failed for item', item.item_id, mode || 'combined', perItemErr?.response?.data || perItemErr);
      }
    }

    let reclassifiedCount = 0;
    let txnReclassifiedCount = 0;
    let backfilledCount = 0;
    let dedupedCount = 0;
    if (mode === 'deep-refresh') {
      try {
        reclassifiedCount = await reclassifyPendingReviews(userId);
        txnReclassifiedCount = await reclassifyStoredTransactions(userId);
        backfilledCount = await backfillDashboardReviews(userId);
        dedupedCount = await dedupeDashboardReviews(userId);
      } catch (deepErr) {
        console.error('Deep refresh reclassify/backfill/dedupe failed:', deepErr?.response?.data || deepErr);
      }
    }

    console.log('plaid-sync-recurring result:', { userId, mode: mode || 'combined', totalAdded, totalQueued, orphansCleaned, reclassifiedCount, txnReclassifiedCount, backfilledCount, dedupedCount });
    res.status(200).json({ success: true, totalAdded, totalQueued, orphansCleaned, reclassifiedCount, txnReclassifiedCount, backfilledCount, dedupedCount });
  } catch (err) {
    console.error('plaid-sync-recurring error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not sync recurring transactions' });
  }
};
  