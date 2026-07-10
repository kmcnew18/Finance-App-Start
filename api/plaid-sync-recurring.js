// /api/plaid-sync-recurring.js
//
// Manually runs the same pipeline the webhook runs automatically —
// re-sync transactions, refresh recurring streams, queue reviews for
// anything newly matched. Useful as a "Refresh" button on the Connections
// page, and as a fallback if a webhook was ever missed (Plaid retries
// webhooks, but nothing is 100% guaranteed on the internet).
//
// Requires: npm install plaid @supabase/supabase-js

const { supabaseAdmin, processItemUpdate } = require('../lib/plaid-helpers');
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
    const { userId } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
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
        const result = await processItemUpdate(item);
        totalAdded += result.addedCount;
        totalQueued += result.queuedCount;
      } catch (perItemErr) {
        console.error('Recurring sync failed for item', item.item_id, perItemErr?.response?.data || perItemErr);
      }
    }

    res.status(200).json({ success: true, totalAdded, totalQueued, orphansCleaned });
  } catch (err) {
    console.error('plaid-sync-recurring error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not sync recurring transactions' });
  }
};