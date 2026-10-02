// /api/cleanup-audit-log.js
//
// Deletes audit_log rows older than 12 months. Triggered by Vercel Cron
// (see the "crons" entry in vercel.json) — not called from the app itself.
// This is what makes the Data Retention Policy's "12 months, then
// automatically purged" claim actually true, rather than aspirational.
//
// Requires: npm install @supabase/supabase-js

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  // Vercel Cron sends a GET request with this header — reject anything else
  // so this can't be triggered by an arbitrary public request.
  const isVercelCron = req.headers['x-vercel-cron'] !== undefined;
  if (!isVercelCron && process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);

    const { error, count } = await supabaseAdmin
      .from('audit_log')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff.toISOString());

    if (error) throw error;

    console.log(`Audit log cleanup: removed ${count ?? 0} entries older than ${cutoff.toISOString()}`);
    res.status(200).json({ success: true, removed: count ?? 0 });
  } catch (err) {
    console.error('cleanup-audit-log error:', err);
    res.status(500).json({ error: err.message });
  }
};
