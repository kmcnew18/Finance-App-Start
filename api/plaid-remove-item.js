// /api/plaid-remove-item.js
//
// Fully revokes a Plaid Item: calls Plaid's /item/remove (which invalidates
// the access_token at Plaid's end, not just in our own database), then
// deletes our local record of it and any recurring-transaction data tied
// to it. Called from the client only after confirming no other
// linked_accounts rows still reference this item (one Plaid Item can back
// multiple accounts — checking + savings from the same bank, for
// example — so this should only fire once the last one is removed).
//
// Requires: npm install plaid @supabase/supabase-js

const { plaidClient, supabaseAdmin } = require('./_plaid-helpers');
const { decryptToken } = require('./_crypto-helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { itemId, userId } = req.body || {};
    if (!itemId || !userId) {
      res.status(400).json({ error: 'Missing itemId or userId' });
      return;
    }

    const { data: itemRow, error: fetchError } = await supabaseAdmin
      .from('plaid_items')
      .select('*')
      .eq('item_id', itemId)
      .eq('user_id', userId) // scoped to the requesting user — never remove someone else's item
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!itemRow) {
      // Already gone (or never existed) — nothing to revoke, but not an error.
      res.status(200).json({ success: true, alreadyRemoved: true });
      return;
    }

    // Revoke at Plaid's end — this is the actual disposal step. Without
    // this, the access_token would keep working even after we've deleted
    // our own copy of it, since Plaid doesn't know we're done with it.
    try {
      await plaidClient.itemRemove({ access_token: decryptToken(itemRow.access_token) });
    } catch (plaidErr) {
      // If Plaid already considers the Item invalid/removed (e.g. the user
      // revoked it from their bank's side, or from my.plaid.com), this
      // call can fail — that's fine, it means there's nothing left to
      // revoke. Log it, but still proceed to clean up our own records.
      console.error('Plaid itemRemove failed (proceeding with local cleanup anyway):', plaidErr?.response?.data || plaidErr);
    }

    // Local disposal — actually delete, not just mark inactive.
    await supabaseAdmin.from('plaid_items').delete().eq('item_id', itemId).eq('user_id', userId);
    await supabaseAdmin.from('recurring_streams').delete().eq('plaid_item_id', itemId).eq('user_id', userId);

    await supabaseAdmin.from('audit_log').insert({
      user_id: userId,
      event_type: 'plaid_item_revoked',
      detail: { item_id: itemId, institution_name: itemRow.institution_name },
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('plaid-remove-item error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not fully revoke this connection' });
  }
};
