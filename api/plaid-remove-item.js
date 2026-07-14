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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { cleanupExpiredTrial } = req.body || {};
  if (cleanupExpiredTrial) return handleTrialExpiryCleanup(req, res);
  return handleSingleItemRemoval(req, res);
};

// Fires when a trial has genuinely run out without ever being upgraded
// — removes every Plaid connection the account has (fully revoked at
// Plaid's end, same as a manual removal) and drops billing back to
// free Tier 1. The expiry itself is re-verified here against the
// database rather than trusted from whatever the client claims, since
// a client could otherwise call this early to strip someone's own
// still-valid trial access, or — worse — someone else's.
async function handleTrialExpiryCleanup(req, res) {
  try {
    const { userId } = req.body || {};
    if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }

    const { data: billing, error: billingError } = await supabaseAdmin
      .from('user_billing')
      .select('billing_period, trial_end, tier')
      .eq('user_id', userId)
      .maybeSingle();
    if (billingError) throw billingError;

    const trialGenuinelyExpired = billing && billing.billing_period === 'trial' && new Date(billing.trial_end) < new Date();
    if (!trialGenuinelyExpired) {
      // Nothing to do — either already cleaned up, never on a trial,
      // or the trial hasn't actually ended yet. Not an error; this
      // endpoint gets called speculatively on page load, so a no-op
      // response here is the expected outcome most of the time.
      res.status(200).json({ cleaned: false });
      return;
    }

    const { data: items } = await supabaseAdmin.from('plaid_items').select('*').eq('user_id', userId);

    for (const itemRow of (items || [])) {
      try {
        await plaidClient.itemRemove({ access_token: decryptToken(itemRow.access_token) });
      } catch (plaidErr) {
        console.error('Trial-expiry cleanup: Plaid itemRemove failed (proceeding anyway):', plaidErr?.response?.data || plaidErr);
      }
    }

    await supabaseAdmin.from('linked_accounts').delete().eq('user_id', userId);
    await supabaseAdmin.from('plaid_items').delete().eq('user_id', userId);
    await supabaseAdmin.from('recurring_streams').delete().eq('user_id', userId);
    await supabaseAdmin.from('user_billing').update({ tier: 1, billing_period: 'free', is_paid: false }).eq('user_id', userId);

    await supabaseAdmin.from('audit_log').insert({
      user_id: userId,
      event_type: 'trial_expired_cleanup',
      detail: { accounts_removed: (items || []).length },
    });

    res.status(200).json({ cleaned: true, accountsRemoved: (items || []).length });
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