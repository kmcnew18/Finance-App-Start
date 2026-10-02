// lib/auth-guard.js
//
// Server-side checks for the /api endpoints. Every query in those
// endpoints runs on the service-role client, which bypasses Row Level
// Security, so a `userId` in a request body proves nothing on its own —
// these confirm who is actually calling.
//
//   requireUser(req, res, userId)  the caller holds a valid session for
//                                  exactly this user.
//   requireMfa(req, res, userId)   the above, plus two-factor: either the
//                                  session itself is AAL2 (a code was
//                                  entered), or the request carries proof
//                                  of a device trusted within the last 30
//                                  days (see lib/device-trust.js). Used on
//                                  anything that changes which banks are
//                                  connected.
//
// Both send the error response themselves and return null on failure,
// so a handler just does:  const auth = await requireMfa(req, res, userId);
//                          if (!auth) return;

const crypto = require('crypto');
const { supabaseAdmin } = require('./plaid-helpers');

async function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  // getUser() has just validated this token with the auth server, so its
  // claims (including the assurance level) can be read directly.
  let claims = {};
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (_) { /* leave claims empty — treated as AAL1 */ }
  return { userId: data.user.id, user: data.user, aal: claims.aal || 'aal1' };
}

// X-Arko-Device: "<deviceId>.<secret>". Valid only if the secret hashes
// to a live record in the user's app_metadata whose authenticator is
// still enrolled.
function hasTrustedDeviceProof(req, user) {
  const raw = req.headers['x-arko-device'];
  if (typeof raw !== 'string' || raw.length > 200) return false;
  const dot = raw.indexOf('.');
  if (dot < 1) return false;
  const deviceId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  const now = Date.now();
  const records = Array.isArray(user?.app_metadata?.trusted_devices) ? user.app_metadata.trusted_devices : [];
  const record = records.find(d => d && d.id === deviceId && Date.parse(d.exp) > now);
  if (!record || typeof record.hash !== 'string' || record.hash.length !== 64) return false;
  const factorOk = (user.factors || []).some(f => f.id === record.factor && f.status === 'verified');
  if (!factorOk) return false;
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(record.hash, 'hex'));
}

async function requireUser(req, res, userId) {
  const auth = await authenticate(req);
  if (!auth) { res.status(401).json({ error: 'Please sign in again.' }); return null; }
  if (userId && auth.userId !== userId) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return auth;
}

async function requireMfa(req, res, userId) {
  const auth = await requireUser(req, res, userId);
  if (!auth) return null;
  if (auth.aal === 'aal2' || hasTrustedDeviceProof(req, auth.user)) return auth;
  res.status(403).json({ error: 'Two-factor verification is required for this. Enter your authenticator code and try again.', code: 'mfa_required' });
  return null;
}

module.exports = { authenticate, requireUser, requireMfa };
