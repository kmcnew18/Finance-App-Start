// /api/plaid-connection-status.js
//
// Returns which of a user's Plaid connections need reconnecting (flagged
// by the webhook or a failed sync), and why. Deliberately a separate,
// narrow endpoint rather than letting the client query plaid_items
// directly — that table holds encrypted access tokens, and even though
// they're encrypted, there's no reason for the client to ever fetch that
// row at all. This returns only the safe fields.
//
// Requires: npm install @supabase/supabase-js

const { createClient } = require('@supabase/supabase-js');

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

    const { data, error } = await supabaseAdmin
      .from('plaid_items')
      .select('item_id, institution_name, needs_reconnect, reconnect_reason, new_accounts_available')
      .eq('user_id', userId);

    if (error) throw error;

    res.status(200).json({ items: data || [] });
  } catch (err) {
    console.error('plaid-connection-status error:', err);
    res.status(500).json({ error: 'Could not check connection status' });
  }
};
