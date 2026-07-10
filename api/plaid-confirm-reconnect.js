// /api/plaid-confirm-reconnect.js
//
// Called after Link's onSuccess fires in Update Mode. Unlike a brand new
// connection, update mode doesn't return a new public_token to exchange —
// the existing access_token is still valid, it's just been
// re-authenticated. This just clears the reconnect flag and triggers a
// fresh sync, since reconnecting can also reveal newly-added accounts.
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
    const { userId, itemId } = req.body || {};
    if (!userId || !itemId) {
      res.status(400).json({ error: 'Missing userId or itemId' });
      return;
    }

    const { data: itemRow, error: fetchError } = await supabaseAdmin
      .from('plaid_items')
      .select('*')
      .eq('item_id', itemId)
      .eq('user_id', userId)
      .maybeSingle();
    if (fetchError || !itemRow) {
      res.status(404).json({ error: 'Could not find that connection' });
      return;
    }

    await supabaseAdmin
      .from('plaid_items')
      .update({ needs_reconnect: false, reconnect_reason: null })
      .eq('item_id', itemId);

    // Refresh balances immediately so the reconnect feels like it actually
    // did something, rather than the user waiting for the next sync.
    try {
      const balancesRes = await plaidClient.accountsBalanceGet({ access_token: decryptToken(itemRow.access_token) });
      for (const a of balancesRes.data.accounts || []) {
        await supabaseAdmin
          .from('linked_accounts')
          .update({ balance: Math.abs(a.balances.current ?? a.balances.available ?? 0), updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('plaid_account_id', a.account_id);
      }
    } catch (balanceErr) {
      console.error('Post-reconnect balance refresh failed (non-fatal):', balanceErr?.response?.data || balanceErr);
    }

    // Also catch up on anything transactions-related that was missed
    // while the connection was broken.
    try {
      await processItemUpdate({ ...itemRow, needs_reconnect: false });
    } catch (syncErr) {
      console.error('Post-reconnect transaction sync failed (non-fatal):', syncErr?.response?.data || syncErr);
    }

    await supabaseAdmin.from('audit_log').insert({
      user_id: userId,
      event_type: 'plaid_item_reconnected',
      detail: { item_id: itemId, institution_name: itemRow.institution_name },
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('plaid-confirm-reconnect error:', err);
    res.status(500).json({ error: 'Could not confirm reconnection' });
  }
};
