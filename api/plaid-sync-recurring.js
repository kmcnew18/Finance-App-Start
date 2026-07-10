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

    let totalAdded = 0;
    let totalQueued = 0;

    for (const item of items || []) {
      try {
        const result = await processItemUpdate(item);
        totalAdded += result.addedCount;
        totalQueued += result.queuedCount;
      } catch (perItemErr) {
        console.error('Recurring sync failed for item', item.item_id, perItemErr?.response?.data || perItemErr);
      }
    }

    res.status(200).json({ success: true, totalAdded, totalQueued });
  } catch (err) {
    console.error('plaid-sync-recurring error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not sync recurring transactions' });
  }
};
