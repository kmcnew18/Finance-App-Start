// /lib/crypto-helpers.js
//
// Lives in /lib, not /api — see the comment at the top of
// /lib/plaid-helpers.js for why (Vercel's 12-function limit on the
// Hobby plan). Imported via require('../lib/crypto-helpers').
//
// Encrypts sensitive fields (Plaid access_tokens) before they're written to
// Supabase, and decrypts them when read back for use. This is
// application-level encryption — on top of whatever disk-level encryption
// your database host already provides — and it's what "Do you encrypt
// consumer data retrieved from the Plaid API at-rest?" on Plaid's security
// questionnaire is really asking about. Answering "Yes" without this in
// place would not be accurate; with it, it is.
//
// Uses AES-256-GCM (authenticated encryption — detects tampering, not just
// confidentiality).
//
// Required environment variable:
//   PLAID_TOKEN_ENCRYPTION_KEY   a 32-byte key, base64-encoded.
//     Generate one with:
//       node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//     Store the output as this env var on your backend host. Treat it with
//     the same care as PLAID_SECRET — if this key is ever lost, every
//     already-stored access_token becomes permanently undecryptable and
//     every user will need to re-link their accounts. Back it up somewhere
//     safe (a password manager, not a repo).

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const keyB64 = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error('PLAID_TOKEN_ENCRYPTION_KEY is not set — see comments in _crypto-helpers.js to generate one');
  }
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('PLAID_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

// Returns a single string safe to store in a text column:
// base64(iv) + ":" + base64(authTag) + ":" + base64(ciphertext)
function encryptToken(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptToken(stored) {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Stored token is not in the expected encrypted format');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encryptToken, decryptToken };