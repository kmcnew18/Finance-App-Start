// lib/device-trust.js
//
// "Trust this device for 30 days" for two-factor authentication.
//
// Every sign-in starts a fresh AAL1 session, so without this the
// authenticator code was needed again on every login (and the 10-minute
// idle sign-out made logins frequent). A trusted device skips the code
// prompt in the app's MFA gates until it expires.
//
// What keeps this from weakening 2FA:
//   - Trust can only be minted from a session that is *already* AAL2,
//     i.e. right after a real authenticator code was entered. A password
//     alone can't produce one.
//   - Records live in app_metadata, which only the service role can
//     write — unlike user_metadata, a signed-in user can't add their own.
//   - Each device holds a random 256-bit secret it generated itself; only
//     its SHA-256 hash is ever sent or stored. The browser proves trust
//     by hashing its secret and finding a live record for it. (Generated
//     client-side so the request can be fire-and-forget with keepalive —
//     verifying usually navigates straight to Connections, which would
//     otherwise cut off a response carrying the secret back.)
//   - Each record is bound to the authenticator factor that minted it, so
//     removing or replacing the authenticator voids every trusted device.
//   - Records expire after 30 days and can be revoked from Manage 2FA.
//
// Routed through api/plaid-item-actions.js (actions 'trust_device' /
// 'untrust_device') only to stay under the Hobby plan's 12-function cap.

const { supabaseAdmin } = require('./plaid-helpers');
const { authenticate } = require('./auth-guard');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUST_DAYS = 30;
const MAX_TRUSTED_DEVICES = 8; // app_metadata rides along in every JWT — keep it small

async function readTrustedDevices(userId) {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) throw error;
  const now = Date.now();
  const list = Array.isArray(data.user?.app_metadata?.trusted_devices) ? data.user.app_metadata.trusted_devices : [];
  return list.filter(d => d && d.id && d.hash && Date.parse(d.exp) > now);
}

async function writeTrustedDevices(userId, devices) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { app_metadata: { trusted_devices: devices } });
  if (error) throw error;
}

async function handleTrustDevice(req, res) {
  try {
    const auth = await authenticate(req);
    if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (auth.aal !== 'aal2') { res.status(403).json({ error: 'Verify your authenticator code first' }); return; }

    const { deviceId, hash, factorId, label } = req.body || {};
    if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      res.status(400).json({ error: 'Invalid device' });
      return;
    }
    const { data: factorData, error: factorError } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: auth.userId });
    if (factorError) throw factorError;
    const factor = (factorData?.factors || []).find(f => f.id === factorId && f.status === 'verified');
    if (!factor) { res.status(400).json({ error: 'Unknown authenticator' }); return; }

    const record = {
      id: deviceId,
      hash,
      factor: factor.id,
      label: String(label || 'Browser').replace(/[^\w .,()/-]/g, '').slice(0, 48) || 'Browser',
      created: new Date().toISOString(),
      exp: new Date(Date.now() + TRUST_DAYS * 86400000).toISOString(),
    };

    const existing = (await readTrustedDevices(auth.userId)).filter(d => d.id !== deviceId);
    const devices = [...existing, record].slice(-MAX_TRUSTED_DEVICES);
    await writeTrustedDevices(auth.userId, devices);
    await supabaseAdmin.from('audit_log').insert({ user_id: auth.userId, event_type: 'mfa_device_trusted', detail: { label: record.label } });

    res.status(200).json({ success: true, expiresAt: record.exp });
  } catch (err) {
    console.error('trust_device error:', err);
    res.status(500).json({ error: 'Could not trust this device' });
  }
}

// Revoking only ever reduces access, so it's allowed from an AAL1
// session too (e.g. forgetting a lost laptop from a new login).
async function handleUntrustDevice(req, res) {
  try {
    const auth = await authenticate(req);
    if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const { deviceId, all } = req.body || {};
    const devices = await readTrustedDevices(auth.userId);
    const remaining = all ? [] : devices.filter(d => d.id !== deviceId);
    await writeTrustedDevices(auth.userId, remaining);
    await supabaseAdmin.from('audit_log').insert({ user_id: auth.userId, event_type: 'mfa_device_forgotten', detail: { all: !!all, removed: devices.length - remaining.length } });

    res.status(200).json({ success: true, remaining: remaining.length });
  } catch (err) {
    console.error('untrust_device error:', err);
    res.status(500).json({ error: 'Could not forget device' });
  }
}

module.exports = { handleTrustDevice, handleUntrustDevice };
