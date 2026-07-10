// /api/plaid-add-new-accounts.js
//
// Called after Link succeeds in Update Mode, triggered by a
// NEW_ACCOUNTS_AVAILABLE prompt. Unlike a brand-new connection, the
// access_token doesn't change — the user just granted access to
// additional accounts under the same Item. This re-fetches the full
// account list and inserts whichever ones aren't already in
// linked_accounts, using the same type-mapping logic as a first-time
// connection.
//
// Requires: npm install plaid @supabase/supabase-js

const { plaidClient, supabaseAdmin, mapAccountType } = require('../lib/plaid-helpers');
const { decryptToken } = require('../lib/crypto-helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
    console.error('plaid-add-new-accounts error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not add the new account(s)' });
  }
};
