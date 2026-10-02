// /api/daily-maintenance.js
//
// Daily Vercel Cron job (see "crons" in vercel.json) — not called from
// the app itself. Was cleanup-audit-log.js; renamed when it took on more
// than the audit log, and kept as one function because the Hobby plan's
// 12-function limit is already reached.
//
//   1. Audit log retention: deletes audit_log rows older than 12 months
//      (what makes the Data Retention Policy's "12 months, then purged"
//      claim true).
//   2. Account lifecycle (lib/maintenance.js): expired trials → free tier
//      with bank connections revoked; free-tier accounts still holding
//      connections → revoked; trial-ending reminders; and the
//      inactive-connection policy (warn after 90 days away, pause
//      connections 14 days later, keeping the accounts as manual ones).
//
// Auth: when the CRON_SECRET environment variable is set, Vercel sends it
// as "Authorization: Bearer <secret>" on cron invocations and anything
// else is rejected. Without it, falls back to the x-vercel-cron header
// (spoofable, but every action here only applies to accounts that
// genuinely meet its conditions, so an early trigger changes nothing
// the next scheduled run wouldn't).

const { supabaseAdmin } = require('../lib/plaid-helpers');
const { runDailyMaintenance } = require('../lib/maintenance');

function authorized(req) {
  if (process.env.CRON_SECRET) return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  return req.headers['x-vercel-cron'] !== undefined || process.env.NODE_ENV !== 'production';
}

module.exports = async (req, res) => {
  if (!authorized(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const started = Date.now();
  const result = { auditLogRemoved: 0 };

  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const { error, count } = await supabaseAdmin
      .from('audit_log')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff.toISOString());
    if (error) throw error;
    result.auditLogRemoved = count ?? 0;
  } catch (err) {
    console.error('daily-maintenance: audit log cleanup failed:', err);
  }

  try {
    // Leave headroom under the function's 60s limit (vercel.json); any
    // accounts not reached today are picked up tomorrow.
    Object.assign(result, await runDailyMaintenance({ deadlineMs: started + 50 * 1000 }));
  } catch (err) {
    console.error('daily-maintenance: lifecycle run failed:', err);
    result.lifecycleError = true;
  }

  console.log('daily-maintenance result:', result);
  res.status(200).json({ success: true, ...result });
};
