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

const { plaidClient, supabaseAdmin } = require('../lib/plaid-helpers');
const { decryptToken } = require('../lib/crypto-helpers');
const { requireUser, requireMfa } = require('../lib/auth-guard');
const { cleanupExpiredTrial } = require('../lib/maintenance');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { cleanupExpiredTrial: isTrialCleanup } = req.body || {};
  if (isTrialCleanup) return handleTrialExpiryCleanup(req, res);
  return handleSingleItemRemoval(req, res);
};

// Fires when a trial has genuinely run out without ever being upgraded
// — revokes every Plaid connection the account has, removes the
// bank-connected accounts (manual ones stay), and drops billing back
// to free Tier 1. The expiry itself is re-verified against the
// database rather than trusted from whatever the client claims, since
// a client could otherwise call this early to strip someone's own
// still-valid trial access, or — worse — someone else's.
async function handleTrialExpiryCleanup(req, res) {
  try {
    const { userId } = req.body || {};
    if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
    // Sign-in only, not two-factor: this fires automatically on page load
    // and the expiry is re-verified (in cleanupExpiredTrial) regardless
    // of who asks. Same routine the daily cron runs for users who never
    // come back — see lib/maintenance.js. Not an error when there's
    // nothing to do; this is called speculatively, so { cleaned: false }
    // is the usual answer.
    if (!await requireUser(req, res, userId)) return;

    const result = await cleanupExpiredTrial(userId);
    res.status(200).json(result.cleaned ? { cleaned: true, accountsRemoved: result.accountsRemoved } : { cleaned: false });
  } catch (err) {
    console.error('plaid-remove-item (trial cleanup) error:', err?.response?.data || err);
    res.status(500).json({ error: 'Could not complete trial-expiry cleanup' });
  }
}

async function handleSingleItemRemoval(req, res) {
  try {
    const { itemId, userId } = req.body || {};
    if (!itemId || !userId) {
      res.status(400).json({ error: 'Missing itemId or userId' });
      return;
    }
    if (!await requireMfa(req, res, userId)) return;

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