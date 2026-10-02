// lib/maintenance.js
//
// Account lifecycle rules that run on the server — from the daily cron
// (api/daily-maintenance.js) and, for trial expiry, also the moment a
// user with an expired trial loads Dashboard/Connections.
//
//   1. Trial expiry. A 14-day trial (api/register-trial.js) reads as
//      Tier 3 in the browser until trial_end, then Tier 1. Once it has
//      ended without an upgrade, every bank connection is revoked at
//      Plaid (which is what stops the per-connection monthly fees), the
//      bank-connected accounts are removed, and billing is set to the
//      free tier. Manually added accounts and all budget/log data stay,
//      as the Privacy Policy promises.
//   2. Free tier holding connections. Anyone whose plan no longer
//      includes Connections (e.g. a cancelled subscription) gets the
//      same disconnect — previously nothing ever removed those.
//   3. Inactivity. A connection nobody is looking at still costs a
//      monthly Plaid fee. After INACTIVE_WARN_DAYS without opening
//      Arko, the user gets one email; if they still don't come back
//      within INACTIVE_GRACE_DAYS, their banks are disconnected —
//      gently: the accounts stay as manual ones with their last balance
//      and category, so nothing visible is lost, and reconnecting is
//      one click. Opening the app at any point resets the clock.
//
// "Last active" is app_metadata.last_active_at, stamped by
// lib/auth-guard.js whenever the signed-in user's pages call the API
// (falls back to last_sign_in_at for accounts that predate that).

const { plaidClient, supabaseAdmin } = require('./plaid-helpers');
const { decryptToken } = require('./crypto-helpers');

const DAY = 24 * 60 * 60 * 1000;
const INACTIVE_WARN_DAYS = 90;
const INACTIVE_GRACE_DAYS = 14;
const TRIAL_REMINDER_HOURS = 48;
const APP_URL = 'https://arkofinance.com';

function effectiveTier(billing) {
  if (!billing) return 1;
  if (billing.billing_period === 'trial') return new Date(billing.trial_end) > new Date() ? 3 : 1;
  return billing.tier || 1;
}

// ---------- disconnecting ----------
// mode 'remove'      — delete the bank-connected accounts (trial expiry,
//                      free tier): the plan no longer includes them.
// mode 'keep-manual' — keep them as manual accounts with their last
//                      balance and category (inactivity, user choice).
async function disconnectItems(userId, items, mode) {
  let accountsAffected = 0;
  const failures = [];
  for (const item of items) {
    try {
      await plaidClient.itemRemove({ access_token: decryptToken(item.access_token) });
    } catch (plaidErr) {
      // Already invalid at Plaid (user revoked it, etc.) means there's
      // nothing left to revoke — carry on with local cleanup either way.
      console.error('disconnectItems: Plaid itemRemove failed (continuing):', item.item_id, plaidErr?.response?.data || plaidErr.message);
    }

    let accountsError = null;
    if (mode === 'keep-manual') {
      const { data, error } = await supabaseAdmin
        .from('linked_accounts')
        .update({ source: 'manual', plaid_item_id: null, plaid_account_id: null, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('plaid_item_id', item.item_id)
        .select('id');
      accountsError = error;
      accountsAffected += (data || []).length;
    } else {
      const { data, error } = await supabaseAdmin
        .from('linked_accounts')
        .delete()
        .eq('user_id', userId)
        .eq('plaid_item_id', item.item_id)
        .select('id');
      accountsError = error;
      accountsAffected += (data || []).length;
    }
    if (accountsError) {
      failures.push(item.item_id);
      console.error('disconnectItems: linked_accounts cleanup failed:', item.item_id, accountsError);
    }

    await supabaseAdmin.from('recurring_streams').delete().eq('plaid_item_id', item.item_id).eq('user_id', userId);
    await supabaseAdmin.from('plaid_items').delete().eq('item_id', item.item_id).eq('user_id', userId);
  }
  return { itemsRemoved: items.length, accountsAffected, failures };
}

async function itemsFor(userId) {
  const { data, error } = await supabaseAdmin.from('plaid_items').select('*').eq('user_id', userId);
  if (error) throw error;
  return data || [];
}

// ---------- 1 & 2: plan-based cleanup ----------
async function cleanupExpiredTrial(userId) {
  const { data: billing, error } = await supabaseAdmin
    .from('user_billing').select('billing_period, trial_end, tier').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  const expired = billing && billing.billing_period === 'trial' && new Date(billing.trial_end) < new Date();
  if (!expired) return { cleaned: false };

  const items = await itemsFor(userId);
  const result = await disconnectItems(userId, items, 'remove');
  // Any bank-connected account whose connection row was already gone.
  const { data: strays } = await supabaseAdmin
    .from('linked_accounts').delete().eq('user_id', userId).eq('source', 'plaid').select('id');
  const accountsRemoved = result.accountsAffected + (strays || []).length;

  await supabaseAdmin.from('user_billing').update({ tier: 1, billing_period: 'free', is_paid: false }).eq('user_id', userId);
  await supabaseAdmin.from('audit_log').insert({
    user_id: userId, event_type: 'trial_expired_cleanup',
    detail: { connections_removed: result.itemsRemoved, accounts_removed: accountsRemoved },
  });
  return { cleaned: true, accountsRemoved, connectionsRemoved: result.itemsRemoved };
}

async function cleanupFreeTierConnections(userId, billing) {
  const items = await itemsFor(userId);
  if (!items.length) return { cleaned: false };
  const result = await disconnectItems(userId, items, 'remove');
  await supabaseAdmin.from('audit_log').insert({
    user_id: userId, event_type: 'free_tier_connections_removed',
    detail: { connections_removed: result.itemsRemoved, accounts_removed: result.accountsAffected, billing_period: billing?.billing_period || null },
  });
  return { cleaned: true, ...result };
}

// ---------- email ----------
let resendClient = null;
function resend() {
  if (!resendClient && process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}
function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: process.env.APP_TIMEZONE || 'America/Chicago' });
}
function emailHtml(heading, paragraphs, cta) {
  return `<!doctype html><html><body style="margin:0;background:#0D1117;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:520px;background:#12181F;border:1px solid #26313E;border-radius:14px;" cellspacing="0" cellpadding="0"><tr><td style="padding:30px 28px;">
    <div style="color:#6E8FA3;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;margin-bottom:14px;">Arko Finance</div>
    <h1 style="margin:0 0 14px;color:#E8E1D3;font-family:Georgia,serif;font-size:22px;font-weight:600;">${heading}</h1>
    ${paragraphs.map(p => `<p style="margin:0 0 14px;color:#B3B6B9;font-size:15px;line-height:1.6;">${p}</p>`).join('')}
    ${cta ? `<p style="margin:22px 0 4px;"><a href="${cta.href}" style="display:inline-block;background:#4FC3E8;color:#0B1117;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:999px;">${cta.label}</a></p>` : ''}
  </td></tr></table>
  <p style="color:#7C8489;font-size:12px;margin:16px 0 0;">You're receiving this because you have an Arko account.</p>
  </td></tr></table></body></html>`;
}
async function sendEmail(to, subject, heading, paragraphs, cta) {
  const client = resend();
  if (!client || !to) return false;
  const { error } = await client.emails.send({
    from: 'Arko <notices@mail.arkofinance.com>',
    to,
    subject,
    html: emailHtml(heading, paragraphs, cta),
    text: [heading, '', ...paragraphs.map(p => p.replace(/<[^>]+>/g, '')), cta ? `\n${cta.label}: ${cta.href}` : ''].join('\n\n'),
  });
  if (error) { console.error('maintenance email rejected:', subject, error); return false; }
  return true;
}

async function setAppMeta(userId, patch) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { app_metadata: patch });
  if (error) console.error('setAppMeta failed:', userId, error);
}

// The newest of: the app's own heartbeat (activity.js stamps
// user_metadata.last_active_at at most every 12h on any app page), a
// server-side baseline, and the last password sign-in. Sessions stay
// open across visits, so last_sign_in_at alone would make a daily user
// look inactive.
function lastActive(user) {
  const stamps = [user.user_metadata?.last_active_at, user.app_metadata?.activity_baseline_at, user.last_sign_in_at]
    .map(t => (t ? Date.parse(t) : NaN)).filter(n => !isNaN(n));
  return stamps.length ? Math.max.apply(null, stamps) : null;
}

// ---------- 3: inactivity ----------
async function applyInactivityPolicy(user, items) {
  const now = Date.now();
  // Accounts from before the heartbeat existed have no reliable activity
  // record yet — start their clock today rather than judging them on a
  // stale sign-in date.
  if (!user.user_metadata?.last_active_at && !user.app_metadata?.activity_baseline_at) {
    await setAppMeta(user.id, { activity_baseline_at: new Date().toISOString() });
    return 'baseline';
  }
  const active = lastActive(user) || now;
  const idleDays = Math.floor((now - active) / DAY);
  const warnedAt = user.app_metadata?.inactivity_warned_at ? Date.parse(user.app_metadata.inactivity_warned_at) : null;

  if (idleDays < INACTIVE_WARN_DAYS) return 'active';

  // Warned, still hasn't been back since, grace period over → disconnect.
  if (warnedAt && warnedAt > active && now - warnedAt >= INACTIVE_GRACE_DAYS * DAY) {
    const result = await disconnectItems(user.id, items, 'keep-manual');
    await setAppMeta(user.id, { inactivity_warned_at: null, inactivity_disconnected_at: new Date().toISOString() });
    await supabaseAdmin.from('audit_log').insert({
      user_id: user.id, event_type: 'inactive_connections_disconnected',
      detail: { idle_days: idleDays, connections_removed: result.itemsRemoved, accounts_kept_as_manual: result.accountsAffected },
    });
    await sendEmail(user.email, 'We paused your bank connections in Arko',
      'Your bank connections are paused',
      [
        `Since you haven't opened Arko in a while, we disconnected your linked banks so they're not syncing in the background.`,
        `Nothing is lost: your accounts are still in Arko as manual accounts with their last balances, and your budgets, log, and goals are untouched.`,
        `Want them syncing again? Sign in and use <b>+ Connect account</b> in Connections — it only takes a minute.`,
      ],
      { label: 'Open Arko', href: `${APP_URL}/login` });
    return 'disconnected';
  }

  // First time crossing the line (or active again since an old warning) → warn once.
  if (!warnedAt || warnedAt <= active) {
    const disconnectOn = new Date(now + INACTIVE_GRACE_DAYS * DAY);
    const sent = await sendEmail(user.email, 'Your Arko bank connections will pause soon',
      'Still using Arko?',
      [
        `It's been about ${Math.round(idleDays / 30)} months since you last opened Arko. To avoid syncing banks nobody's looking at, we'll pause your bank connections on <b>${fmtDate(disconnectOn)}</b>.`,
        `Just sign in any time before then and everything stays connected. If they do pause, your accounts stay in Arko as manual accounts with their last balances — nothing else changes.`,
      ],
      { label: 'Sign in to keep them', href: `${APP_URL}/login` });
    // Only start the grace clock if the warning actually went out.
    if (sent) await setAppMeta(user.id, { inactivity_warned_at: new Date().toISOString() });
    return sent ? 'warned' : 'warn-failed';
  }
  return 'waiting';
}

async function sendTrialReminderIfDue(user, billing) {
  if (!billing || billing.billing_period !== 'trial') return false;
  const end = new Date(billing.trial_end).getTime();
  const left = end - Date.now();
  if (left <= 0 || left > TRIAL_REMINDER_HOURS * 60 * 60 * 1000) return false;
  if (user.app_metadata?.trial_reminder_sent_for === billing.trial_end) return false;
  const sent = await sendEmail(user.email, 'Your Arko trial ends soon',
    'Your free trial ends ' + fmtDate(new Date(end)),
    [
      `Thanks for trying Arko. Your full access ends on <b>${fmtDate(new Date(end))}</b>.`,
      `To keep your banks syncing, Spendings, Investments, and Visual Savings, pick a plan before then. Otherwise your account moves to the free plan: connected banks are disconnected, and your manual accounts, budgets, and log stay exactly as they are.`,
    ],
    { label: 'See plans', href: `${APP_URL}/paywall.html` });
  if (sent) await setAppMeta(user.id, { trial_reminder_sent_for: billing.trial_end });
  return sent;
}

// ---------- the daily run ----------
async function runDailyMaintenance({ deadlineMs } = {}) {
  const outOfTime = () => deadlineMs && Date.now() > deadlineMs;
  const summary = { trialsExpired: 0, freeTierCleaned: 0, reminders: 0, warned: 0, disconnected: 0, errors: 0 };

  // Expired trials, whether or not the user has any connections — this
  // is also what flips their billing row to the free tier.
  const { data: expired } = await supabaseAdmin
    .from('user_billing').select('user_id').eq('billing_period', 'trial').lt('trial_end', new Date().toISOString());
  for (const row of expired || []) {
    if (outOfTime()) break;
    try { if ((await cleanupExpiredTrial(row.user_id)).cleaned) summary.trialsExpired++; }
    catch (e) { summary.errors++; console.error('trial cleanup failed:', row.user_id, e); }
  }

  // Trials ending in the next 48 hours → one reminder email each.
  const soon = new Date(Date.now() + TRIAL_REMINDER_HOURS * 60 * 60 * 1000).toISOString();
  const { data: ending } = await supabaseAdmin
    .from('user_billing').select('user_id, billing_period, trial_end, tier')
    .eq('billing_period', 'trial').gt('trial_end', new Date().toISOString()).lte('trial_end', soon);
  for (const b of ending || []) {
    if (outOfTime()) break;
    try {
      const { data } = await supabaseAdmin.auth.admin.getUserById(b.user_id);
      if (data?.user && await sendTrialReminderIfDue(data.user, b)) summary.reminders++;
    } catch (e) { summary.errors++; console.error('trial reminder failed:', b.user_id, e); }
  }

  // Everyone who still has bank connections: plan check, then inactivity.
  const { data: itemRows } = await supabaseAdmin.from('plaid_items').select('*');
  const byUser = {};
  (itemRows || []).forEach(i => { (byUser[i.user_id] = byUser[i.user_id] || []).push(i); });
  for (const userId of Object.keys(byUser)) {
    if (outOfTime()) break;
    try {
      const { data: billing } = await supabaseAdmin
        .from('user_billing').select('billing_period, trial_end, tier').eq('user_id', userId).maybeSingle();
      if (effectiveTier(billing) < 2) {
        if ((await cleanupFreeTierConnections(userId, billing)).cleaned) summary.freeTierCleaned++;
        continue;
      }
      const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (!data?.user) continue;
      const outcome = await applyInactivityPolicy(data.user, byUser[userId]);
      if (outcome === 'warned') summary.warned++;
      if (outcome === 'disconnected') summary.disconnected++;
    } catch (e) { summary.errors++; console.error('connection maintenance failed:', userId, e); }
  }
  return summary;
}

module.exports = {
  effectiveTier,
  disconnectItems,
  cleanupExpiredTrial,
  runDailyMaintenance,
  INACTIVE_WARN_DAYS,
  INACTIVE_GRACE_DAYS,
};
