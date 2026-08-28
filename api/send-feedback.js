// /api/send-feedback.js
//
// Sends a feedback submission to contact@mail.arkofinance.com via
// Resend. Deliberately mail.arkofinance.com, not the bare
// arkofinance.com — the root domain has no MX record at all (its DNS
// is just the A/CNAME pointing at Vercel for the site itself), so
// mail addressed to contact@arkofinance.com had nowhere to actually
// land and sat stuck in "delivery delayed." mail.arkofinance.com
// already has a working inbound MX record (AWS SES) from the
// existing Resend domain setup.
// No database write — this is deliberately just an email, not a stored
// record, since feedback doesn't need to live in the app's own data.
//
// Requires: npm install resend
//
// Required environment variable:
//   RESEND_API_KEY   — already in use elsewhere in the app for
//   transactional email (signup confirmations, etc.)
//
// NOTE ON FUNCTION COUNT: this is the 12th file in /api, which is the
// Vercel Hobby plan's exact limit — there's no room left for another
// endpoint without either consolidating something existing (the way
// plaid-item-actions.js merged three files earlier) or upgrading to Pro.

const { Resend } = require('resend');
const { supabaseAdmin } = require('../lib/plaid-helpers');

const resend = new Resend(process.env.RESEND_API_KEY);

const TYPE_LABELS = {
  bug: 'Bug report',
  improvement: 'Improvement idea',
  question: 'Question',
  other: 'Other',
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { name, type, message } = req.body || {};
    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    // Verify against a real session and use the verified email, not a
    // client-supplied one. This form is only ever shown to a logged-in
    // user (every page it's reachable from requires a session), so
    // there's no legitimate anonymous path being closed off here —
    // trusting a client-supplied "account email" would otherwise let
    // anyone send feedback that looks like it came from someone else's
    // inbox.
    const authHeaderVal = req.headers.authorization || '';
    const token = authHeaderVal.startsWith('Bearer ') ? authHeaderVal.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing authorization token' }); return; }
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const userEmail = authData.user.email;

    const typeLabel = TYPE_LABELS[type] || 'Feedback';
    const fromName = name && name.trim() ? name.trim() : 'Anonymous';

    // The SDK never throws for an API-level rejection (bad "from"
    // domain, unverified sender, etc.) — it always resolves with
    // {data, error}, even on failure. Only network-level problems
    // (caught below) throw. Skipping this check was the bug: the
    // endpoint reported success unconditionally regardless of whether
    // Resend actually accepted the email.
    const { data, error } = await resend.emails.send({
      from: 'Arko Feedback <feedback@mail.arkofinance.com>',
      to: 'contact@mail.arkofinance.com',
      reply_to: userEmail,
      subject: `[${typeLabel}] Feedback from ${fromName}`,
      text: [
        `Type: ${typeLabel}`,
        `Name: ${fromName}`,
        `Account email: ${userEmail}`,
        '',
        message.trim(),
      ].join('\n'),
    });

    if (error) {
      console.error('send-feedback: Resend rejected the send:', error);
      res.status(502).json({ error: 'Could not send feedback right now' });
      return;
    }

    console.log('send-feedback: sent, Resend id:', data?.id);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('send-feedback error:', err);
    res.status(500).json({ error: 'Could not send feedback right now' });
  }
};
