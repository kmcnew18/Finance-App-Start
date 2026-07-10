// /api/send-feedback.js
//
// Sends a feedback submission to contact@arkofinance.com via Resend.
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
    const { name, type, message, userEmail } = req.body || {};
    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const typeLabel = TYPE_LABELS[type] || 'Feedback';
    const fromName = name && name.trim() ? name.trim() : 'Anonymous';

    await resend.emails.send({
      from: 'Arko Feedback <feedback@mail.arkofinance.com>',
      to: 'contact@arkofinance.com',
      reply_to: userEmail || undefined,
      subject: `[${typeLabel}] Feedback from ${fromName}`,
      text: [
        `Type: ${typeLabel}`,
        `Name: ${fromName}`,
        `Account email: ${userEmail || 'not signed in / not provided'}`,
        '',
        message.trim(),
      ].join('\n'),
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('send-feedback error:', err);
    res.status(500).json({ error: 'Could not send feedback right now' });
  }
};
