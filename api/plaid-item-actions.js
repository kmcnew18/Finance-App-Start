// /api/plaid-item-actions.js
//
// Combines three small, related endpoints into one file, dispatched by an
// `action` field in the request body — purely to stay under Vercel's
// Hobby plan limit of 12 Serverless Functions per deployment (each file
// directly inside /api counts as one, regardless of how small). None of
// the actual logic below changed from when these were three separate
// files; only the routing did.
//
//   action: 'status'            — GET-style: which connections need
//                                  reconnecting or have new accounts
//                                  available (was plaid-connection-status.js)
//   action: 'confirm_reconnect' — finishes an Update Mode reconnect
//                                  (was plaid-confirm-reconnect.js)
//   action: 'add_new_accounts'  — finishes granting access to a newly
//                                  available account, or dismisses that
//                                  prompt (was plaid-add-new-accounts.js)
//
// Requires: npm install plaid @supabase/supabase-js

const { plaidClient, supabaseAdmin, mapAccountType, processItemUpdate } = require('../lib/plaid-helpers');
const { decryptToken } = require('../lib/crypto-helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { action } = req.body || {};

  if (action === 'status') return handleStatus(req, res);
  if (action === 'confirm_reconnect') return handleConfirmReconnect(req, res);
  if (action === 'add_new_accounts') return handleAddNewAccounts(req, res);

  res.status(400).json({ error: 'Missing or unrecognized action' });
};

// ---------- status ----------
async function handleStatus(req, res) {
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
    console.error('plaid-item-actions (status) error:', err);
    res.status(500).json({ error: 'Could not check connection status' });
  }
}

// ---------- confirm_reconnect ----------
async function handleConfirmReconnect(req, res) {
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
    console.error('plaid-item-actions (confirm_reconnect) error:', err);
    res.status(500).json({ error: 'Could not confirm reconnection' });
  }
}

// ---------- add_new_accounts ----------
async function handleAddNewAccounts(req, res) {
  try {
    const { userId, itemId, dismissOnly } = req.body || {};
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

    // Clear the flag regardless of what's found below — the user has
    // responded to the prompt either way, no reason to keep showing it.
    await supabaseAdmin.from('plaid_items').update({ new_accounts_available: false }).eq('item_id', itemId);

    if (dismissOnly) {
      res.status(200).json({ success: true, dismissed: true });
      return;
    }

    const { data: existingAccounts } = await supabaseAdmin
      .from('linked_accounts')
      .select('plaid_account_id')
      .eq('user_id', userId)
      .eq('plaid_item_id', itemId);
    const existingIds = new Set((existingAccounts || []).map(a => a.plaid_account_id));

    const balancesRes = await plaidClient.accountsBalanceGet({ access_token: decryptToken(itemRow.access_token) });
    const plaidAccounts = balancesRes.data.accounts || [];

    const newRows = plaidAccounts
      .filter(a => !existingIds.has(a.account_id))
      .map(a => ({
        user_id: userId,
        institution_name: itemRow.institution_name,
        nickname: a.name || a.official_name || null,
        account_type: mapAccountType(a.type, a.subtype),
        balance: Math.abs(a.balances.current ?? a.balances.available ?? 0),
        source: 'plaid',
        plaid_item_id: itemId,
        plaid_account_id: a.account_id,
      }));

    if (newRows.length) {
      const { error: insertError } = await supabaseAdmin.from('linked_accounts').insert(newRows);
      if (insertError) throw insertError;

      await supabaseAdmin.from('audit_log').insert({
        user_id: userId,
        event_type: 'plaid_new_accounts_added',
        detail: { item_id: itemId, institution_name: itemRow.institution_name, count: newRows.length },
      });
    }

    res.status(200).json({ success: true, accountsAdded: newRows.length });
  } catch (err) {
    console.error('plaid-item-actions (add_new_accounts) error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not add the new account(s)' });
  }
}
