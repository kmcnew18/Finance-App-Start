// /api/plaid-webhook.js
//
// Plaid POSTs here automatically whenever something changes — most
// relevantly, SYNC_UPDATES_AVAILABLE when new transactions show up. This
// endpoint must be publicly reachable (it's what PLAID_WEBHOOK_URL in
// plaid-create-link-token.js points to) and does NOT use your normal
// Supabase auth — Plaid isn't a logged-in user, it's authenticated via a
// signed JWT in the Plaid-Verification header instead, verified below.
//
// Requires: npm install plaid @supabase/supabase-js jsonwebtoken jwk-to-pem
//
// Same environment variables as the other Plaid functions, no new ones.
//
// IMPORTANT: signature verification below hashes req.body after your
// framework has already parsed it back into an object. That's fine as long
// as your framework doesn't reorder/alter the JSON during parsing (Vercel's
// default body parser preserves this correctly). If you switch frameworks
// and verification starts failing, switch to hashing the raw request body
// string instead of JSON.stringify(req.body).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwkToPem = require('jwk-to-pem');
const { plaidClient, supabaseAdmin, processItemUpdate } = require('./_plaid-helpers');

async function verifyWebhook(req) {
  const signedJwt = req.headers['plaid-verification'];
  if (!signedJwt) throw new Error('Missing Plaid-Verification header');

  const decoded = jwt.decode(signedJwt, { complete: true });
  if (!decoded) throw new Error('Could not decode webhook JWT');

  const keyRes = await plaidClient.webhookVerificationKeyGet({ key_id: decoded.header.kid });
  const pem = jwkToPem(keyRes.data.key);

  const claims = jwt.verify(signedJwt, pem, { algorithms: ['ES256'] });

  // Reject anything older than 5 minutes — Plaid's own recommendation, to
  // block replay of a captured webhook payload.
  if (Date.now() / 1000 - claims.iat > 300) {
    throw new Error('Webhook JWT is too old');
  }

  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
  if (bodyHash !== claims.request_body_sha256) {
    throw new Error('Webhook body hash does not match signature');
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await verifyWebhook(req);
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  const { webhook_type, webhook_code, item_id } = req.body || {};

  // Acknowledge quickly — Plaid retries if it doesn't get a fast 200. For
  // an app this size, doing the work inline before responding is simpler
  // than standing up a queue, and still comfortably fast; if this ever
  // starts timing out under real load, move the body of this handler into
  // a background job and just enqueue it here instead.
  try {
    if (webhook_type === 'TRANSACTIONS' && webhook_code === 'SYNC_UPDATES_AVAILABLE') {
      const { data: itemRow, error } = await supabaseAdmin
        .from('plaid_items')
        .select('*')
        .eq('item_id', item_id)
        .maybeSingle();

      if (error || !itemRow) {
        console.error('Webhook for unknown item_id:', item_id);
        res.status(200).json({ received: true }); // still 200 — not Plaid's fault
        return;
      }

      const result = await processItemUpdate(itemRow);
      console.log(`Processed webhook for item ${item_id}:`, result);
    } else if (
      webhook_type === 'ITEM' &&
      ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(webhook_code)
    ) {
      // The Item needs the user to re-authenticate — bank password
      // changed, consent expiring, institution migrating APIs, etc.
      // Flag it so the Connections page can surface a "Reconnect" prompt;
      // syncing for this Item will keep failing silently until the user
      // completes Link again in update mode.
      const reasons = {
        ITEM_LOGIN_REQUIRED: 'Your bank requires you to sign in again to keep this connection active.',
        PENDING_EXPIRATION: 'This connection is about to expire and needs to be renewed.',
        PENDING_DISCONNECT: 'Your bank is migrating this connection — reconnect to avoid an interruption.',
      };

      const { error: flagError } = await supabaseAdmin
        .from('plaid_items')
        .update({ needs_reconnect: true, reconnect_reason: reasons[webhook_code] })
        .eq('item_id', item_id);

      if (flagError) {
        console.error('Could not flag item for reconnect:', flagError);
      } else {
        console.log(`Flagged item ${item_id} for reconnect (${webhook_code})`);
      }
    } else if (webhook_type === 'ITEM' && webhook_code === 'USER_PERMISSION_REVOKED') {
      // The user revoked access from their bank's side or via
      // my.plaid.com — this Item is dead, not just broken. Clean it up
      // the same way plaid-remove-item.js does, rather than leaving a
      // permanently-broken "reconnect" prompt the user can never resolve.
      await supabaseAdmin.from('plaid_items').delete().eq('item_id', item_id);
      await supabaseAdmin.from('recurring_streams').delete().eq('plaid_item_id', item_id);
      console.log(`Item ${item_id} access revoked by user — removed locally`);
    } else {
      // Other webhook types not handled yet — logged so you can see them
      // come through and decide what, if anything, to build for them.
      console.log('Unhandled webhook:', webhook_type, webhook_code);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('plaid-webhook processing error:', err?.response?.data || err);
    // Still return 200 so Plaid doesn't hammer retries for an error on our
    // side that a retry won't fix — the next scheduled sync or manual
    // "Sync all accounts" click will catch up.
    res.status(200).json({ received: true, processingError: true });
  }
};
