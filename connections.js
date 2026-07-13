const SUPABASE_URL = "https://pkfkdmjuwkfkbkmlmoxq.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrZmtkbWp1d2tma2JrbWxtb3hxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNzIxMTIsImV4cCI6MjA5ODg0ODExMn0.MWUcOvwttx1y0iE_Rcc6aUoJ7F5jmT-mMrQfOTwqmOY";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUserId = null;
let currentUserEmail = null;
let isPaidUser = false;
let accounts = [];
let categories = [];
let accountSplits = []; // account_category_splits rows

const DEFAULT_CATEGORIES = [
  { name: 'Savings', accent: 'teal' },
  { name: 'Investment', accent: 'violet' },
  { name: 'Expenses', accent: 'coral' },
  { name: 'Checking', accent: 'gold' },
];

// Suggests a starting category by name for a given account type — the
// "smart default" that lets most people just tap "Looks good" instead
// of thinking about it. Returns null when there's no sensible
// single-category guess (credit cards/loans are debts, not something
// that fills a spending category).
function suggestCategoryName(accountType) {
  const map = { checking: 'Checking', savings: 'Savings', investment: 'Investment', crypto: 'Investment' };
  return map[accountType] || null;
}
let editingAccountId = null; // set when the modal is being used to edit, not create

// ================= ACCOUNT TYPE CONFIG =================
const ACCOUNT_TYPES = [
  { key: 'checking',    label: 'Checking',            isLiability: false, dot: '#6EC4E0' },
  { key: 'savings',     label: 'Savings',             isLiability: false, dot: '#63D9AA' },
  { key: 'investment',  label: 'Investment / Broker', isLiability: false, dot: '#E0B96E' },
  { key: 'credit_card', label: 'Credit Cards',        isLiability: true,  dot: '#E0806A' },
  { key: 'loan',        label: 'Loans',               isLiability: true,  dot: '#B27AC4' },
  { key: 'crypto',      label: 'Crypto',               isLiability: false, dot: '#D97FC4' },
  { key: 'other',       label: 'Other',                isLiability: false, dot: '#B3B6B9' },
];
function typeConfig(key) { return ACCOUNT_TYPES.find(t => t.key === key) || ACCOUNT_TYPES[ACCOUNT_TYPES.length - 1]; }

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  }));
}
function money(n) {
  const num = Number(n || 0);
  const sign = num < 0 ? '-' : '';
  return sign + '$' + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Fire-and-forget audit trail write. Never blocks or fails the action
// it's logging — an audit log that could break the feature it watches
// isn't one you actually want in production.
function logAuditEvent(eventType, detail) {
  supabaseClient.from('audit_log').insert({ user_id: currentUserId, event_type: eventType, detail: detail || {} })
    .then(({ error }) => { if (error) console.error('Audit log write failed:', error); });
}

// ================= INIT / GATE =================
async function init() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = 'login.html'; return; }
  currentUserId = session.user.id;
  currentUserEmail = session.user.email;

  const { data: billing } = await supabaseClient
    .from('user_billing').select('is_paid, trial_end').eq('user_id', currentUserId).maybeSingle();
  // Connections is now covered by the free trial, same as Dashboard and
  // Log — seeing real, synced accounts is a big part of what makes the
  // trial worth trying in the first place. Once the trial actually
  // expires (and the account still isn't paid), this sends to the
  // trial-expiry paywall page, not straight to Stripe checkout.
  const isPaidAccount = !!(billing && billing.is_paid);
  const trialExpired = !billing || new Date(billing.trial_end) < new Date();
  if (trialExpired && !isPaidAccount) { window.location.href = 'paywall.html'; return; }
  isPaidUser = isPaidAccount;

  setupLedgerMenu();
  setupSettingsGear();
  setupConnectOverlay();
  setupMfaOverlay();
  setupActivityPanel();
  setupCategoryOverlay();
  setupManageCategories();
  setupFeedback();
  setupIdleTimeout();

  // Blocks here until the user has enrolled AND verified a second
  // factor for this session — the rest of the page (accounts, net
  // worth, everything) does not load until this resolves. Cancelling
  // out sends them back to Dashboard rather than leaving them stuck
  // staring at a blocked, empty Connections page.
  document.getElementById('loading-message').textContent = 'Checking two-factor authentication…';
  const verified = await requireMfaVerified(true);
  if (!verified) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('loading-message').textContent = 'Loading your accounts...';
  await loadAccounts();

  document.getElementById('loading-message').style.display = 'none';
  document.getElementById('vault-shell').style.display = 'flex';

  // Balances only ever get fresh numbers from Plaid on initial connection
  // or an explicit manual sync — nothing was proactively keeping them
  // current otherwise. Rather than block the page on a Plaid round-trip
  // every single time someone opens Connections, show what's already
  // stored first (fast), then quietly refresh in the background and
  // re-render once real numbers come back — balances catch up within a
  // second or two of landing here, without adding a wait to get in.
  refreshBalancesInBackground();

  // If this page load is actually the browser returning from a
  // bank's OAuth login (mobile web round-trip), resume the Link flow
  // that was in progress before the redirect.
  await checkForOAuthReturn();
}

// How often the background balance refresh is allowed to actually call
// Plaid. Every page load used to trigger a real API call regardless of
// how recently one had already happened — harmless in Sandbox, but in
// Production each of those calls has a real cost. Set to 12 hours (2
// times a day) per updated direction — was 6 hours before.
const BACKGROUND_SYNC_THROTTLE_MS = 12 * 60 * 60 * 1000;

function shouldRunBackgroundSync() {
  const plaidAccounts = accounts.filter(a => a.source === 'plaid' && a.last_synced_at);
  if (!plaidAccounts.length) return true; // nothing synced yet — go ahead
  const mostRecent = plaidAccounts.reduce((latest, a) =>
    new Date(a.last_synced_at) > new Date(latest) ? a.last_synced_at : latest, plaidAccounts[0].last_synced_at);
  return (Date.now() - new Date(mostRecent).getTime()) > BACKGROUND_SYNC_THROTTLE_MS;
}

async function refreshBalancesInBackground() {
  if (!shouldRunBackgroundSync()) return;
  try {
    const res = await fetch('/api/plaid-sync-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId })
    });
    if (res.ok) await loadAccounts(); // silent — just re-renders with fresh numbers, no loading state shown
  } catch (err) {
    console.error('Background balance refresh failed:', err);
  }
}

// Straight to Stripe — no stop at paywall.html, since that page is
// specifically for "your trial ended," and this isn't that.
async function redirectToCheckout(userId, email) {
  try {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, email })
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      window.location.href = 'paywall.html'; // fallback if checkout couldn't start
    }
  } catch (err) {
    console.error(err);
    window.location.href = 'paywall.html'; // fallback
  }
}

let connectionStatus = [];

let pendingByAccountId = {};

async function loadAccounts() {
  const { data, error } = await supabaseClient
    .from('linked_accounts')
    .select('*')
    .eq('user_id', currentUserId)
    .order('created_at', { ascending: true });
  if (error) { console.error(error); accounts = []; return; }
  accounts = data || [];
  await loadConnectionStatus();
  await loadCategories();
  await cleanUpCreditCardCategorySplits();
  await loadPendingAmounts();
  renderAll();
  renderLastSynced();
}

// Credit card balances from Plaid mirror whatever the card issuer
// reports — and issuers commonly report only the posted balance, with
// pending charges not reflected until they settle, sometimes days
// later. This sums what's actually pending right now on each credit
// card so the real amount owed can be shown alongside the posted one,
// rather than silently under-representing it.
async function loadPendingAmounts() {
  pendingByAccountId = {};
  const creditCardIds = accounts.filter(a => a.account_type === 'credit_card').map(a => a.id);
  if (!creditCardIds.length) return;

  const { data: pendingTxns, error } = await supabaseClient
    .from('transactions')
    .select('linked_account_id, amount, is_pending')
    .eq('user_id', currentUserId)
    .eq('is_pending', true)
    .eq('is_removed', false)
    .in('linked_account_id', creditCardIds);

  if (error) {
    // This used to fail completely silently — if the schema migration
    // adding is_pending hasn't been run yet, this query errors out and
    // pendingByAccountId just stays empty with no indication anything
    // was wrong. Logging it directly so that's actually diagnosable
    // instead of just "nothing shows up, not sure why."
    console.error('loadPendingAmounts failed (is the is_pending column migrated yet?):', error);
    return;
  }

  console.log('loadPendingAmounts result:', { creditCardCount: creditCardIds.length, pendingTxnCount: (pendingTxns || []).length, pendingTxns });

  (pendingTxns || []).forEach(t => {
    const amt = Number(t.amount) || 0;
    if (amt <= 0) return; // only actual charges count toward amount owed, not pending refunds/credits
    pendingByAccountId[t.linked_account_id] = round2((pendingByAccountId[t.linked_account_id] || 0) + amt);
  });
}

// Shows the most recent sync across every Plaid-connected account —
// manual accounts don't count, since nothing auto-syncs those. Updates
// live while the panel's open rather than freezing at whatever it said
// on page load, so "2 minutes ago" doesn't quietly go stale.
let lastSyncedInterval = null;
function renderLastSynced() {
  const label = document.getElementById('last-synced-label');
  const syncBtn = document.getElementById('sync-all-btn');
  const anyPlaidAccounts = accounts.some(a => a.source === 'plaid');
  syncBtn.style.display = anyPlaidAccounts ? 'flex' : 'none';

  const plaidAccounts = accounts.filter(a => a.source === 'plaid' && a.last_synced_at);
  clearInterval(lastSyncedInterval);

  if (!plaidAccounts.length) { label.style.display = 'none'; return; }

  const mostRecent = plaidAccounts.reduce((latest, a) =>
    new Date(a.last_synced_at) > new Date(latest) ? a.last_synced_at : latest, plaidAccounts[0].last_synced_at);

  const update = () => { label.textContent = `Last synced ${relativeTimeFromNow(mostRecent)}`; };
  update();
  label.style.display = 'inline-block';
  lastSyncedInterval = setInterval(update, 30000);
}

function relativeTimeFromNow(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Credit cards no longer map to a category (see openCategoryMapping) —
// this quietly clears out any mapping made before that rule existed,
// so old data doesn't linger inconsistently with what's shown now.
async function cleanUpCreditCardCategorySplits() {
  const creditCardIds = accounts.filter(a => a.account_type === 'credit_card').map(a => a.id);
  if (!creditCardIds.length) return;
  const staleSplitIds = accountSplits.filter(s => creditCardIds.includes(s.linked_account_id)).map(s => s.id);
  if (!staleSplitIds.length) return;
  await supabaseClient.from('account_category_splits').delete().in('id', staleSplitIds);
  accountSplits = accountSplits.filter(s => !staleSplitIds.includes(s.id));
}

// A category with manually set-aside money (nothing connected yet) and
// a category with a real connected account are mutually exclusive —
// see budget_categories.manual_amount's own comment for why. This is
// the enforcement point: called before every place that would connect
// an account to a category, blocking it and telling the user to clear
// the manual amount first rather than silently mixing real and
// manually-typed money into one total.
function blockIfCategoryHasManualAmount(categoryId) {
  const cat = categories.find(c => c.id === categoryId);
  if (cat && Number(cat.manual_amount) > 0) {
    alert(`"${cat.name}" has ${money(Number(cat.manual_amount))} set aside manually on Dashboard. Clear that amount first before connecting an account here — a category can't be both manually tracked and connected at once.`);
    return true;
  }
  return false;
}

async function loadCategories() {
  const { data, error } = await supabaseClient
    .from('budget_categories')
    .select('*')
    .eq('user_id', currentUserId)
    .order('sort_order', { ascending: true });
  if (error) { console.error(error); categories = []; return; }

  // First time this user has ever reached this feature — seed the
  // four categories they already had, so nothing changes for them
  // until they actively choose to add more. No setup step forced.
  if (!data.length) {
    const seedRows = DEFAULT_CATEGORIES.map((c, i) => ({
      user_id: currentUserId, name: c.name, accent: c.accent, is_default: true, sort_order: i,
    }));
    const { data: seeded, error: seedError } = await supabaseClient.from('budget_categories').insert(seedRows).select();
    if (seedError) { console.error(seedError); categories = []; return; }
    categories = seeded || [];
  } else {
    categories = data;
  }

  const { data: splits, error: splitsError } = await supabaseClient
    .from('account_category_splits')
    .select('*')
    .eq('user_id', currentUserId);
  if (splitsError) { console.error(splitsError); accountSplits = []; return; }
  accountSplits = splits || [];
}

async function loadConnectionStatus() {
  try {
    const res = await fetch('/api/plaid-item-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', userId: currentUserId })
    });
    const data = await res.json();
    connectionStatus = data.items || [];
  } catch (err) {
    console.error('Could not load connection status:', err);
    connectionStatus = [];
  }
}

// ================= RENDER =================
function renderAll() {
  renderNetWorth();
  renderNewAccountsBanner();
  renderAccountGroups();
  renderCharts();
}

function renderNewAccountsBanner() {
  const wrap = document.getElementById('new-accounts-banner');
  const flagged = connectionStatus.filter(i => i.new_accounts_available);

  if (!flagged.length) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  wrap.style.display = 'block';
  wrap.innerHTML = flagged.map(item => `
    <div class="new-accounts-banner-row">
      <span class="new-accounts-banner-text">A new account is available at <strong>${(item.institution_name || 'your bank').replace(/</g,'&lt;')}</strong> — want to add it?</span>
      <div class="new-accounts-banner-actions">
        <button type="button" class="new-accounts-add-btn" data-item-id="${item.item_id}" data-institution="${(item.institution_name || 'this account').replace(/"/g,'&quot;')}">Add it</button>
        <button type="button" class="new-accounts-dismiss-btn" data-item-id="${item.item_id}" aria-label="Dismiss">×</button>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('.new-accounts-add-btn').forEach(btn => {
    btn.addEventListener('click', () => addNewAccounts(btn.dataset.itemId, btn.dataset.institution, btn));
  });
  wrap.querySelectorAll('.new-accounts-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', () => dismissNewAccountsPrompt(btn.dataset.itemId));
  });
}

function renderNetWorth() {
  let assets = 0, liabilities = 0;
  accounts.forEach(a => {
    const bal = round2(Number(a.balance) || 0);
    if (typeConfig(a.account_type).isLiability) {
      liabilities += bal;
      if (a.account_type === 'credit_card') liabilities += (pendingByAccountId[a.id] || 0);
    } else {
      assets += bal;
    }
  });
  const netWorth = round2(assets - liabilities);

  const nwEl = document.getElementById('networth-value');
  nwEl.textContent = money(netWorth);
  nwEl.classList.toggle('negative', netWorth < 0);
  document.getElementById('assets-total').textContent = money(assets);
  document.getElementById('liabilities-total').textContent = money(liabilities);
}

function renderAccountGroups() {
  const container = document.getElementById('account-groups');
  const emptyState = document.getElementById('accounts-empty');
  const chartsCard = document.getElementById('vault-charts-card');

  if (!accounts.length) {
    container.innerHTML = '';
    emptyState.style.display = 'block';
    chartsCard.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  chartsCard.style.display = 'block';

  container.innerHTML = ACCOUNT_TYPES.map(t => {
    const group = accounts.filter(a => a.account_type === t.key);
    if (!group.length) return '';
    const total = round2(group.reduce((s, a) => s + (Number(a.balance) || 0), 0));
    const cardsHtml = group.map(a => accountCardHtml(a, t)).join('');
    return `
      <div>
        <div class="account-group-head">
          <span class="account-group-title"><span class="account-group-dot" style="background:${t.dot}; box-shadow:0 0 8px ${t.dot};"></span>${t.label}</span>
          <span class="account-group-total">Total <b>${money(total)}</b></span>
        </div>
        <div class="account-cards">${cardsHtml}</div>
      </div>`;
  }).join('');

  container.querySelectorAll('.account-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });
  container.querySelectorAll('.account-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteAccount(btn.dataset.id));
  });
  container.querySelectorAll('.account-reconnect-btn').forEach(btn => {
    btn.addEventListener('click', () => reconnectItem(btn.dataset.itemId, btn.dataset.institution, btn));
  });
  container.querySelectorAll('.category-pill').forEach(btn => {
    btn.addEventListener('click', () => openCategoryMapping(btn.dataset.accountId));
  });
}

const CONN_ACCENT_COLORS = {
  sage: '#6EC496', blue: '#6E8FA3', coral: '#E0806A', gold: '#D8BC7A', violet: '#A88FD8', teal: '#6EC4B8',
};

function categoryPillHtml(accountId) {
  const splits = accountSplits.filter(s => s.linked_account_id === accountId && s.split_type !== 'envelope');
  const envelopeCount = accountSplits.filter(s => s.linked_account_id === accountId && s.split_type === 'envelope').length;
  const totalPercent = splits.reduce((s, x) => s + Number(x.split_percent), 0);

  let label, cls, accentColor = null;
  if (!splits.length) {
    label = 'Tap to categorize'; cls = 'category-pill-empty';
  } else if (splits.length === 1) {
    const cat = categories.find(c => c.id === splits[0].category_id);
    label = cat ? cat.name : 'Categorized'; cls = 'category-pill-set';
    accentColor = cat ? CONN_ACCENT_COLORS[cat.accent] : null;
  } else {
    label = `Split across ${splits.length}`; cls = 'category-pill-set';
  }
  if (splits.length && totalPercent < 100) label += ` (${Math.round(100 - totalPercent)}% unassigned)`;

  const style = accentColor ? ` style="color:${accentColor}; border-color:${accentColor}44; background:${accentColor}1A;"` : '';
  const pill = `<button type="button" class="category-pill ${cls}" data-account-id="${accountId}"${style}>${label}</button>`;
  const envelopeBadge = envelopeCount
    ? `<button type="button" class="category-pill category-pill-envelope" data-account-id="${accountId}">${envelopeCount === 1 ? '1 amount set aside' : envelopeCount + ' amounts set aside'}</button>`
    : '';
  return pill + envelopeBadge;
}

// Credit cards get a different indicator than the usual category pill —
// "paid from" reflects a debt being covered by a category, not spendable
// money counting toward one. Clicking it opens the same overlay as
// tapping the pill would on any other account.
function creditCardPaidFromPillHtml(acct) {
  const cat = acct.paid_from_category_id ? categories.find(c => c.id === acct.paid_from_category_id) : null;
  const label = cat ? `Paid from ${cat.name}` : 'Not linked to a category';
  const cls = cat ? 'category-pill-set' : 'category-pill-empty';
  const accentColor = cat ? CONN_ACCENT_COLORS[cat.accent] : null;
  const style = accentColor ? ` style="color:${accentColor}; border-color:${accentColor}44; background:${accentColor}1A;"` : '';
  return `<button type="button" class="category-pill ${cls}" data-account-id="${acct.id}"${style}>${label}</button>`;
}

function accountCardHtml(a, t) {
  const brokenItem = a.source === 'plaid' && a.plaid_item_id
    ? connectionStatus.find(i => i.item_id === a.plaid_item_id && i.needs_reconnect)
    : null;

  const synced = brokenItem
    ? `<span class="account-card-reconnect-badge"><span class="dot"></span>Needs reconnecting</span>`
    : a.source === 'plaid'
      ? `<span class="account-card-live-badge"><span class="dot"></span>Synced via Plaid</span>`
      : `<span class="account-card-synced">Added manually</span>`;

  const reconnectBlock = brokenItem ? `
      <div class="account-card-reconnect-block">
        <p>${(brokenItem.reconnect_reason || 'This connection needs to be renewed.').replace(/</g,'&lt;')}</p>
        <button type="button" class="account-reconnect-btn" data-item-id="${brokenItem.item_id}" data-institution="${(brokenItem.institution_name || 'this account').replace(/"/g,'&quot;')}">Reconnect</button>
      </div>` : '';

  const pendingAmount = pendingByAccountId[a.id] || 0;
  const balanceBlock = (a.account_type === 'credit_card' && pendingAmount > 0)
    ? `
      <div class="account-card-balance">${money(a.balance)}</div>
      <div class="account-card-pending-line">+ ${money(pendingAmount)} pending</div>
      <div class="account-card-total-line">${money(round2(a.balance + pendingAmount))} total owed</div>
    `
    : `<div class="account-card-balance">${money(a.balance)}</div>`;

  return `
    <div class="account-card type-${a.account_type}${brokenItem ? ' needs-reconnect' : ''}">
      <div class="account-card-head">
        <div>
          <div class="account-card-institution">${(a.institution_name || '').replace(/</g,'&lt;')}</div>
          ${a.nickname ? `<div class="account-card-nickname">${a.nickname.replace(/</g,'&lt;')}</div>` : ''}
        </div>
        <span class="account-card-type-pill">${t.isLiability ? 'Owed' : 'Balance'}</span>
      </div>
      ${balanceBlock}
      ${synced}
      ${a.account_type === 'credit_card' ? creditCardPaidFromPillHtml(a) : categoryPillHtml(a.id)}
      ${reconnectBlock}
      <div class="account-card-actions" style="margin-top:10px;">
        <button type="button" class="account-edit-btn" data-id="${a.id}">Edit</button>
        <button type="button" class="account-delete-btn danger" data-id="${a.id}">Remove</button>
      </div>
    </div>`;
}

// ================= CHARTS =================
let allocationChart = null;
let assetsLiabilitiesChart = null;

function chartFont() { return { family: "'Public Sans', sans-serif", size: 11 }; }

function renderCharts() {
  if (typeof Chart === 'undefined') return;
  renderAllocationChart();
  renderAssetsLiabilitiesChart();
}

function renderAllocationChart() {
  const canvas = document.getElementById('chart-allocation');
  const emptyNote = document.getElementById('chart-allocation-empty');
  if (!canvas) return;

  const assetTypes = ACCOUNT_TYPES.filter(t => !t.isLiability);
  const labels = [];
  const data = [];
  const colors = [];
  assetTypes.forEach(t => {
    const total = round2(accounts.filter(a => a.account_type === t.key).reduce((s, a) => s + (Number(a.balance) || 0), 0));
    if (total > 0) { labels.push(t.label); data.push(total); colors.push(t.dot); }
  });

  const hasData = data.length > 0;
  if (allocationChart) { allocationChart.destroy(); allocationChart = null; }
  canvas.style.display = hasData ? 'block' : 'none';
  emptyNote.style.display = hasData ? 'none' : 'flex';
  if (!hasData) return;

  allocationChart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: '#0E1613', borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#B3B6B9', font: chartFont(), boxWidth: 10, padding: 12 } },
        tooltip: { callbacks: { label: (item) => `${item.label}: ${money(item.parsed)}` } }
      }
    }
  });
}

function renderAssetsLiabilitiesChart() {
  const canvas = document.getElementById('chart-assets-liabilities');
  const emptyNote = document.getElementById('chart-assets-liabilities-empty');
  if (!canvas) return;

  let assets = 0, liabilities = 0;
  accounts.forEach(a => {
    if (typeConfig(a.account_type).isLiability) liabilities += Number(a.balance) || 0;
    else assets += Number(a.balance) || 0;
  });

  const hasData = (assets > 0 || liabilities > 0);
  if (assetsLiabilitiesChart) { assetsLiabilitiesChart.destroy(); assetsLiabilitiesChart = null; }
  canvas.style.display = hasData ? 'block' : 'none';
  emptyNote.style.display = hasData ? 'none' : 'flex';
  if (!hasData) return;

  assetsLiabilitiesChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['Assets', 'Liabilities'],
      datasets: [{
        data: [round2(assets), round2(liabilities)],
        backgroundColor: ['#63D9AA', '#E0806A'],
        borderRadius: 6,
        maxBarThickness: 60
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#7C8489', font: chartFont() }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: '#7C8489', font: chartFont(), callback: (v) => '$' + v }, grid: { color: 'rgba(232,225,211,0.08)' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => money(item.parsed.y) } }
      }
    }
  });
}

// ================= MANUAL ADD / EDIT =================
function openAddModal() {
  editingAccountId = null;
  document.getElementById('connect-modal-title').textContent = 'Connect an account';
  document.getElementById('connect-modal-sub').textContent = "Link instantly with Plaid, or add an account by hand if it's not supported.";
  document.getElementById('plaid-connect-btn').style.display = 'flex';
  document.querySelector('.vault-divider').style.display = 'flex';
  document.getElementById('manual-save-btn').textContent = 'Save account';
  document.getElementById('acct-institution').value = '';
  document.getElementById('acct-nickname').value = '';
  document.getElementById('acct-type').value = 'checking';
  document.getElementById('acct-balance').value = '';
  document.getElementById('connect-overlay').classList.add('open');
}

function openEditModal(id) {
  const acct = accounts.find(a => a.id === id);
  if (!acct) return;
  editingAccountId = id;
  document.getElementById('connect-modal-title').textContent = 'Edit account';
  document.getElementById('connect-modal-sub').textContent = acct.source === 'plaid'
    ? 'This account syncs automatically via Plaid — you can still rename it or adjust the balance if needed.'
    : 'Update this account\'s details.';
  document.getElementById('plaid-connect-btn').style.display = 'none';
  document.querySelector('.vault-divider').style.display = 'none';
  document.getElementById('manual-save-btn').textContent = 'Save changes';
  document.getElementById('acct-institution').value = acct.institution_name || '';
  document.getElementById('acct-nickname').value = acct.nickname || '';
  document.getElementById('acct-type').value = acct.account_type || 'checking';
  document.getElementById('acct-balance').value = acct.balance || '';
  document.getElementById('connect-overlay').classList.add('open');
}

function closeConnectModal() {
  document.getElementById('connect-overlay').classList.remove('open');
  editingAccountId = null;
}

async function saveManualAccount() {
  const institution = document.getElementById('acct-institution').value.trim();
  const nickname = document.getElementById('acct-nickname').value.trim();
  const type = document.getElementById('acct-type').value;
  const balance = round2(Math.abs(parseFloat(document.getElementById('acct-balance').value) || 0));

  if (!institution) { document.getElementById('acct-institution').focus(); return; }

  if (editingAccountId) {
    const { error } = await supabaseClient
      .from('linked_accounts')
      .update({ institution_name: institution, nickname, account_type: type, balance, updated_at: new Date().toISOString() })
      .eq('id', editingAccountId);
    if (error) { console.error(error); alert('Could not save changes: ' + error.message); return; }
  } else {
    const { error } = await supabaseClient
      .from('linked_accounts')
      .insert({ user_id: currentUserId, institution_name: institution, nickname, account_type: type, balance, source: 'manual' });
    if (error) { console.error(error); alert('Could not add this account: ' + error.message); return; }
  }

  closeConnectModal();
  await loadAccounts();
}

async function deleteAccount(id) {
  const acct = accounts.find(a => a.id === id);
  if (!acct) return;
  if (!confirm(`Remove ${acct.institution_name}${acct.nickname ? ' — ' + acct.nickname : ''}? This cannot be undone.`)) return;
  const { error } = await supabaseClient.from('linked_accounts').delete().eq('id', id);
  if (error) { console.error(error); alert('Could not remove this account: ' + error.message); return; }
  logAuditEvent('linked_account_removed', { institution_name: acct.institution_name, account_type: acct.account_type, source: acct.source });

  // If this was the last account backed by this Plaid Item, fully
  // revoke it at Plaid's end too — not just deleting our local record.
  if (acct.source === 'plaid' && acct.plaid_item_id) {
    const stillReferenced = accounts.some(a => a.id !== id && a.plaid_item_id === acct.plaid_item_id);
    if (!stillReferenced) {
      fetch('/api/plaid-remove-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: acct.plaid_item_id, userId: currentUserId })
      }).catch(err => console.error('Background Plaid item revocation failed:', err));
    }
  }

  await loadAccounts();
}

function setupConnectOverlay() {
  document.getElementById('open-connect-btn').addEventListener('click', openAddModal);
  document.getElementById('connect-close').addEventListener('click', closeConnectModal);
  document.getElementById('connect-cancel-btn').addEventListener('click', closeConnectModal);
  document.getElementById('connect-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'connect-overlay') closeConnectModal();
  });
  document.getElementById('manual-save-btn').addEventListener('click', saveManualAccount);
  document.getElementById('plaid-connect-btn').addEventListener('click', () => startPlaidLink());
}

// ================= PLAID LINK =================
// Requires backend endpoints (see /api/plaid-create-link-token,
// /api/plaid-exchange-token) — see setup notes for what to deploy.
// ================= OAUTH PERSIST / RESUME =================
// On mobile web, completing an OAuth institution's login means the
// browser navigates fully away to the bank's site and back — losing
// all JS state in the process. This is what lets Link pick back up
// where it left off after that round-trip. On desktop, most OAuth
// institutions open in a popup instead and never need this at all —
// it's a no-op there, but harmless to always set.
function persistPlaidLinkState(linkToken, flow, itemId) {
  sessionStorage.setItem('arko_plaid_link_token', linkToken);
  sessionStorage.setItem('arko_plaid_link_flow', JSON.stringify({ flow, itemId: itemId || null }));
}
function clearPlaidLinkState() {
  sessionStorage.removeItem('arko_plaid_link_token');
  sessionStorage.removeItem('arko_plaid_link_flow');
}

// Checked once on page load. If the URL carries Plaid's OAuth return
// params and we have a persisted token + flow from before the
// redirect, resume Link exactly where the user left off — same
// success handlers as a normal (non-OAuth) connection, just entered
// from a different starting point.
async function checkForOAuthReturn() {
  const isOAuthReturn = /[?&]oauth_state_id=/.test(window.location.href);
  if (!isOAuthReturn) return;

  const linkToken = sessionStorage.getItem('arko_plaid_link_token');
  const flowRaw = sessionStorage.getItem('arko_plaid_link_flow');
  if (!linkToken || !flowRaw) return; // nothing to resume — stray or stale redirect, ignore

  const { flow, itemId } = JSON.parse(flowRaw);

  const handler = Plaid.create({
    token: linkToken,
    receivedRedirectUri: window.location.href,
    onSuccess: async (public_token, metadata) => {
      clearPlaidLinkState();
      if (flow === 'new_connection') {
        await finishNewConnection(public_token, metadata?.institution?.name || 'Bank', metadata);
      } else if (flow === 'reconnect') {
        await finishReconnect(itemId);
        await loadAccounts();
      } else if (flow === 'add_new_accounts') {
        await finishAddNewAccounts(itemId);
        await loadAccounts();
      }
    },
    onExit: (err) => {
      clearPlaidLinkState();
      if (err) console.error('Plaid Link (OAuth resume) exit error:', err);
    },
  });
  handler.open();
}

// ---------- shared success handlers (used by both the normal open
// and the OAuth-resume path above) ----------
async function finishNewConnection(publicToken, institutionName, metadata) {
  const accounts = metadata?.accounts || [];
  // Only worth showing a picker when there's an actual choice to make —
  // one account (or Plaid not returning the list for this institution)
  // just proceeds the way it always did.
  if (accounts.length > 1) {
    openAccountSelectPicker(publicToken, institutionName, accounts);
    return;
  }
  await completeAccountExchange(publicToken, institutionName, accounts.map(a => a.id));
}

async function completeAccountExchange(publicToken, institutionName, selectedPlaidAccountIds) {
  try {
    const exRes = await fetch('/api/plaid-exchange-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, publicToken, institutionName, selectedPlaidAccountIds })
    });
    if (!exRes.ok) throw new Error('Could not finish linking this account (' + exRes.status + ')');
    const result = await exRes.json().catch(() => ({}));

    if (!result.accountsAdded) {
      alert(`Connected to ${institutionName}, but no accounts were added — this shouldn't happen. Try "Sync all accounts" from Settings, or reach out if it keeps happening.`);
    }

    closeConnectModal();

    if (result.historicalImport && result.historicalImport.count > 0) {
      showHistoricalImportConsent(result.linkedAccountIds || [], result.historicalImport, institutionName);
    }
    await loadAccounts();
  } catch (err) {
    console.error(err);
    alert(err.message || 'Something went wrong finishing this connection.');
  }
}

// Plaid Link's own metadata.accounts (returned right in onSuccess, no
// extra API call needed) already has everything needed to show this —
// id, name, mask, type. Checked by default since most people linking
// an account want everything from it; unchecking is the exception,
// not the norm.
function openAccountSelectPicker(publicToken, institutionName, accounts) {
  document.getElementById('account-select-heading').textContent = `Accounts at ${institutionName}`;
  const list = document.getElementById('account-select-list');
  list.innerHTML = accounts.map(a => `
    <label class="account-select-row">
      <span class="log-check">
        <input type="checkbox" class="account-select-checkbox" data-account-id="${a.id}" checked />
        <span class="check-box"></span>
      </span>
      <span class="account-select-text">
        <span class="account-select-name">${(a.name || 'Account').replace(/</g,'&lt;')}</span>
        <span class="account-select-meta">${(a.subtype || a.type || '').replace(/</g,'&lt;')}${a.mask ? ' · ····' + a.mask : ''}</span>
      </span>
    </label>
  `).join('');

  const confirmBtn = document.getElementById('account-select-confirm-btn');
  const errorEl = document.getElementById('account-select-error');
  errorEl.style.display = 'none';
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Add selected accounts';

  // Cloning strips any listener from a previous open of this picker —
  // simpler than tracking and removing a named handler each time.
  const freshBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(freshBtn, confirmBtn);
  freshBtn.addEventListener('click', async () => {
    const selectedIds = Array.from(document.querySelectorAll('.account-select-checkbox:checked')).map(cb => cb.dataset.accountId);
    if (!selectedIds.length) { errorEl.textContent = 'Select at least one account.'; errorEl.style.display = 'block'; return; }
    errorEl.style.display = 'none';
    freshBtn.disabled = true;
    freshBtn.textContent = 'Adding…';
    document.getElementById('account-select-overlay').classList.remove('open');
    await completeAccountExchange(publicToken, institutionName, selectedIds);
  });

  document.getElementById('account-select-overlay').classList.add('open');
}

// Right after a new connection, we pull in a bounded window of past
// transactions (this month + last month) purely so Spendings has real
// history to show instead of starting completely blank — but that's a
// meaningful decision to make on someone's behalf, so it's surfaced
// explicitly here rather than done silently. This never affects
// Dashboard either way — Dashboard only ever suggests genuinely new
// activity from the moment of connecting forward, regardless of this
// choice.
function showHistoricalImportConsent(linkedAccountIds, historicalImport, institutionName) {
  const overlay = document.getElementById('historical-import-overlay');
  const body = document.getElementById('historical-import-body');
  const windowLabel = historicalImport.windowStart
    ? new Date(historicalImport.windowStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'long' }) + ' onward'
    : 'recent history';

  body.innerHTML = `
    <p class="mfa-modal-sub">
      We pulled in ${historicalImport.count} transaction${historicalImport.count === 1 ? '' : 's'} from ${(institutionName || 'this account').replace(/</g,'&lt;')}
      (${windowLabel}) so your Spendings page has real history to show right away.
      This only affects Spendings — your Dashboard only ever shows brand-new activity from today forward, either way.
    </p>
    <p class="mfa-modal-sub">Keep this history, or start Spendings fresh from today?</p>
    <button type="button" class="mfa-verify-btn" id="historical-import-keep-btn">Keep it</button>
    <button type="button" class="category-text-link" id="historical-import-remove-btn" style="width:100%; margin-top:8px;">Start fresh instead</button>
  `;
  overlay.classList.add('open');

  document.getElementById('historical-import-keep-btn').addEventListener('click', () => {
    overlay.classList.remove('open');
  });
  document.getElementById('historical-import-remove-btn').addEventListener('click', async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (linkedAccountIds.length) {
      await supabaseClient
        .from('transactions')
        .delete()
        .eq('user_id', currentUserId)
        .in('linked_account_id', linkedAccountIds)
        .lt('txn_date', today);
    }
    logAuditEvent('historical_import_removed', { institution_name: institutionName, count: historicalImport.count });
    overlay.classList.remove('open');
  });
}

async function finishReconnect(itemId) {
  try {
    const confirmRes = await fetch('/api/plaid-item-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm_reconnect', userId: currentUserId, itemId })
    });
    if (!confirmRes.ok) throw new Error('Could not confirm the reconnection (' + confirmRes.status + ')');
  } catch (err) {
    console.error(err);
    alert(err.message || `Reconnected, but couldn't finish syncing — try "Sync all accounts" from Settings.`);
  }
}

async function finishAddNewAccounts(itemId) {
  try {
    const addRes = await fetch('/api/plaid-item-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add_new_accounts', userId: currentUserId, itemId })
    });
    if (!addRes.ok) throw new Error('Could not add the new account (' + addRes.status + ')');
  } catch (err) {
    console.error(err);
    alert(err.message || `Granted access, but couldn't finish adding the account — try "Sync all accounts" from Settings.`);
  }
}

async function startPlaidLink() {
  // No MFA check needed here — the whole page is gated at entry in
  // init(), so reaching this point already means the session is AAL2.
  // Single button now — the backend requests every product Plaid
  // supports, so Link's own account-selection screen is what lets
  // someone pick checking, investments, a credit card, etc. all from
  // the same institution in one pass (e.g. Robinhood's brokerage +
  // Robinhood Gold card), rather than us pre-restricting by category.
  const btn = document.getElementById('plaid-connect-btn');
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = 'Connecting…';

  try {
    const res = await fetch('/api/plaid-create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId })
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const detail = errBody.error_code ? ` (${errBody.error_code})` : '';
      throw new Error((errBody.error || 'Could not start Plaid Link') + detail);
    }
    const { link_token } = await res.json();
    if (!link_token) throw new Error('No link_token returned from server');

    persistPlaidLinkState(link_token, 'new_connection', null);

    const handler = Plaid.create({
      token: link_token,
      onSuccess: async (public_token, metadata) => {
        clearPlaidLinkState();
        btn.innerHTML = 'Finishing up…';
        await finishNewConnection(public_token, metadata?.institution?.name || 'Bank', metadata);
        btn.disabled = false;
        btn.innerHTML = originalText;
      },
      onExit: (err) => {
        clearPlaidLinkState();
        btn.disabled = false;
        btn.innerHTML = originalText;
        if (err) console.error('Plaid Link exit error:', err);
      },
    });
    handler.open();
  } catch (err) {
    console.error(err);
    alert(err.message || 'Could not start Plaid Link. Make sure the backend endpoints are deployed — see setup notes.');
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ================= UPDATE MODE (RECONNECTING A BROKEN CONNECTION) =================
async function reconnectItem(itemId, institutionName, btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    const res = await fetch('/api/plaid-create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, itemId }) // itemId present = Update Mode
    });
    if (!res.ok) throw new Error('Could not start reconnection (' + res.status + ')');
    const { link_token } = await res.json();
    if (!link_token) throw new Error('No link_token returned from server');

    persistPlaidLinkState(link_token, 'reconnect', itemId);

    const handler = Plaid.create({
      token: link_token,
      onSuccess: async () => {
        // Update Mode doesn't return a new public_token to exchange —
        // the existing access_token is still valid, it's just been
        // re-authenticated. Just confirm and re-sync.
        clearPlaidLinkState();
        btn.textContent = 'Finishing up…';
        await finishReconnect(itemId);
        await loadAccounts();
        btn.disabled = false;
        btn.textContent = originalText;
      },
      onExit: (err) => {
        clearPlaidLinkState();
        btn.disabled = false;
        btn.textContent = originalText;
        if (err) console.error('Plaid Link (update mode) exit error:', err);
      },
    });
    handler.open();
  } catch (err) {
    console.error(err);
    alert(err.message || `Could not start reconnecting ${institutionName}.`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ================= NEW ACCOUNTS AVAILABLE =================
// Same Update Mode mechanism as reconnectItem(), but for the happy
// path — granting access to a newly-opened account at a bank
// that's already connected, rather than fixing a broken connection.
async function addNewAccounts(itemId, institutionName, btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    const res = await fetch('/api/plaid-create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, itemId }) // Update Mode
    });
    if (!res.ok) throw new Error('Could not start this (' + res.status + ')');
    const { link_token } = await res.json();
    if (!link_token) throw new Error('No link_token returned from server');

    persistPlaidLinkState(link_token, 'add_new_accounts', itemId);

    const handler = Plaid.create({
      token: link_token,
      onSuccess: async () => {
        clearPlaidLinkState();
        btn.textContent = 'Adding…';
        await finishAddNewAccounts(itemId);
        await loadAccounts();
        btn.disabled = false;
        btn.textContent = originalText;
      },
      onExit: (err) => {
        clearPlaidLinkState();
        btn.disabled = false;
        btn.textContent = originalText;
        if (err) console.error('Plaid Link (new accounts) exit error:', err);
      },
    });
    handler.open();
  } catch (err) {
    console.error(err);
    alert(err.message || `Could not add the new account at ${institutionName}.`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Dismisses the prompt without adding anything — clears the flag
// server-side too, so it doesn't reappear on next page load. If the
// user changes their mind, a fresh new-account webhook or a manual
// sync would surface it again anyway.
async function dismissNewAccountsPrompt(itemId) {
  try {
    await fetch('/api/plaid-item-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add_new_accounts', userId: currentUserId, itemId, dismissOnly: true })
    });
  } catch (err) {
    console.error('Could not dismiss new-accounts prompt:', err);
  }
  await loadAccounts();
}

async function syncAllPlaidAccounts() {
  const syncBtn = document.getElementById('sync-all-btn');
  syncBtn.classList.add('syncing');
  syncBtn.disabled = true;
  try {
    const res = await fetch('/api/plaid-sync-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId })
    });
    if (!res.ok) throw new Error('Sync failed (' + res.status + ')');
    await loadAccounts();

    // Best-effort — balances syncing successfully is the important part,
    // so a recurring-refresh hiccup here shouldn't surface as an error.
    // Recurring streams are displayed in Spendings now, not here, so
    // there's nothing local to re-render — just keeping the data fresh.
    try {
      await fetch('/api/plaid-sync-recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId })
      });
    } catch (recurringErr) {
      console.error('Recurring refresh failed during full sync:', recurringErr);
    }
  } catch (err) {
    console.error(err);
    alert(err.message || 'Could not sync accounts right now.');
  } finally {
    syncBtn.classList.remove('syncing');
    syncBtn.disabled = false;
  }
}

// ================= SETTINGS GEAR =================
function setupSettingsGear() {
  const gearBtn = document.getElementById('settings-gear');
  const gearDropdown = document.getElementById('settings-dropdown');

  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLedgerMenu();
    gearDropdown.classList.toggle('open');
    gearBtn.classList.toggle('spin');
  });
  document.addEventListener('click', () => {
    gearDropdown.classList.remove('open');
    gearBtn.classList.remove('spin');
    closeLedgerMenu();
  });
  gearDropdown.addEventListener('click', (e) => e.stopPropagation());

  document.getElementById('sync-all-btn').addEventListener('click', () => {
    gearDropdown.classList.remove('open');
    syncAllPlaidAccounts();
  });

  // Same underlying sync as Refresh subscriptions — the backend pass
  // already pulls transactions and refreshes subscriptions together in
  // one pass, so these are really the same action with different
  // framing, not two separate pipelines.
  document.getElementById('refresh-transactions-btn').addEventListener('click', async () => {
    gearDropdown.classList.remove('open');
    const btn = document.getElementById('refresh-transactions-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Refreshing…';
    btn.disabled = true;
    try {
      const res = await fetch('/api/plaid-sync-recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, mode: 'transactions' })
      });
      if (!res.ok) throw new Error('Refresh failed (' + res.status + ')');
      btn.textContent = 'Up to date';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (err) {
      console.error(err);
      alert(err.message || 'Could not refresh transactions right now.');
      btn.textContent = originalText;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('refresh-subscriptions-btn').addEventListener('click', async () => {
    gearDropdown.classList.remove('open');
    const btn = document.getElementById('refresh-subscriptions-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Refreshing…';
    btn.disabled = true;
    try {
      const res = await fetch('/api/plaid-sync-recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, mode: 'subscriptions' })
      });
      if (!res.ok) throw new Error('Refresh failed (' + res.status + ')');
      btn.textContent = 'Up to date';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (err) {
      console.error(err);
      alert(err.message || 'Could not refresh subscriptions right now.');
      btn.textContent = originalText;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('clear-transactions-btn').addEventListener('click', async () => {
    gearDropdown.classList.remove('open');
    if (!confirm("Clear your transaction history? This removes everything Spendings and Dashboard have detected so far — nothing about your connected accounts, balances, or subscriptions changes. Going forward, only new activity from this point on will show up.")) return;

    const [{ error: txnError }, { error: dashError }, { error: recurError }] = await Promise.all([
      supabaseClient.from('transactions').delete().eq('user_id', currentUserId),
      supabaseClient.from('pending_dashboard_reviews').delete().eq('user_id', currentUserId),
      supabaseClient.from('pending_transaction_reviews').delete().eq('user_id', currentUserId),
    ]);
    if (txnError || dashError || recurError) {
      alert('Could not fully clear your transaction history: ' + (txnError || dashError || recurError).message);
      return;
    }
    logAuditEvent('transaction_history_cleared', {});
    alert('Your transaction history has been cleared.');
  });

  document.getElementById('clear-subscriptions-btn').addEventListener('click', async () => {
    gearDropdown.classList.remove('open');
    if (!confirm("Clear your detected subscriptions? This removes everything currently shown in Spendings — nothing about your connected accounts, balances, or other transaction history changes. Anything still genuinely recurring will reappear next time you refresh.")) return;

    const { error: streamError } = await supabaseClient.from('recurring_streams').delete().eq('user_id', currentUserId);
    if (streamError) {
      alert('Could not clear your subscriptions: ' + streamError.message);
      return;
    }
    logAuditEvent('subscriptions_cleared', {});
    alert('Your subscriptions have been cleared.');
  });

  document.getElementById('remove-all-btn').addEventListener('click', async () => {
    gearDropdown.classList.remove('open');
    if (!accounts.length) { alert('No accounts to remove.'); return; }
    if (!confirm('Remove every connected account? This cannot be undone. (Manually added and Plaid-linked accounts are both removed — this only clears them from Arko, it does not close any real account.)')) return;

    // Collect distinct Plaid Items before the local rows are gone, so
    // each one can be fully revoked at Plaid's end too.
    const itemIds = [...new Set(accounts.filter(a => a.source === 'plaid' && a.plaid_item_id).map(a => a.plaid_item_id))];

    const { error } = await supabaseClient.from('linked_accounts').delete().eq('user_id', currentUserId);
    if (error) { console.error(error); alert('Could not remove your accounts: ' + error.message); return; }
    logAuditEvent('all_linked_accounts_removed', { count: accounts.length });

    itemIds.forEach(itemId => {
      fetch('/api/plaid-remove-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, userId: currentUserId })
      }).catch(err => console.error('Background Plaid item revocation failed:', err));
    });

    await loadAccounts();
  });
}

document.getElementById('logout-button').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  window.location.href = 'login.html';
});

// ================= PREMIUM FEATURE MENU =================
// Which tools are covered by the free trial vs. requiring full access.
// Connections joined Dashboard/Log here — seeing real, synced accounts
// is a big part of what makes trying the trial worthwhile. Budget
// Planner and Spendings stay paid-only.
const TRIAL_COVERED_TOOL_IDS = ['dashboard', 'connections'];

const PREMIUM_TOOLS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    desc: 'Your accounts, at a glance.',
    href: 'dashboard.html',
    iconClass: 'icon-dashboard',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>'
  },
  {
    id: 'connections',
    label: 'Connections',
    desc: 'Every account, one net worth.',
    href: 'connections.html',
    iconClass: 'icon-connections',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="6" r="3"></circle><circle cx="18" cy="18" r="3"></circle><line x1="8.6" y1="10.6" x2="15.4" y2="7.4"></line><line x1="8.6" y1="13.4" x2="15.4" y2="16.6"></line></svg>'
  },
  {
    id: 'budget',
    label: 'Budget Planner',
    desc: 'Plan, track, and archive monthly budgets.',
    href: 'budget.html',
    iconClass: 'icon-ledger',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><line x1="8.5" y1="7" x2="15.5" y2="7"></line><line x1="8.5" y1="11" x2="15.5" y2="11"></line></svg>'
  },
  {
    id: 'spending',
    label: 'Spendings',
    desc: 'Monthly breakdown and subscriptions.',
    href: 'spending.html',
    iconClass: 'icon-spending',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>'
  },
  {
    id: 'investments',
    label: 'Investments',
    desc: 'Your portfolio, broken down by holding.',
    href: 'investments.html',
    iconClass: 'icon-investments',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><path d="M18.7 8 13 13.7l-3-3L4.3 16.4"></path></svg>'
  },
  {
    id: 'savings',
    label: 'Visual Savings',
    desc: 'Watch your goals grow.',
    href: 'savings.html',
    iconClass: 'icon-savings',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"></path><path d="M8 8h8l2 12H6z"></path><path d="M9 13h6"></path></svg>'
  }
];

function renderLedgerMenu() {
  const inner = document.getElementById('ledger-dropdown-inner');
  const lockBadge = document.getElementById('ledger-lock-badge');
  lockBadge.style.display = isPaidUser ? 'none' : 'flex';
  document.getElementById('ledger-menu-btn').classList.toggle('unlocked', isPaidUser);

  const itemsHtml = PREMIUM_TOOLS.map((tool, i) => {
    const isCurrent = tool.href === 'connections.html';
    const isLocked = !isPaidUser && !TRIAL_COVERED_TOOL_IDS.includes(tool.id);
    const classes = ['ledger-tool-item'];
    if (isCurrent) classes.push('current');
    if (isLocked) classes.push('locked-preview');
    return `
      <button type="button" class="${classes.join(' ')}" data-href="${tool.href}" data-tool-id="${tool.id}"
              style="animation-delay:${i * 55}ms" ${isCurrent ? 'disabled' : ''}>
        <span class="ledger-tool-icon ${tool.iconClass}">${tool.icon}</span>
        <span class="ledger-tool-text">
          <span class="ledger-tool-title">${tool.label}${isCurrent ? ' <span class="current-pill">current</span>' : ''}</span>
          <span class="ledger-tool-desc">${tool.desc}</span>
        </span>
        <span class="ledger-tool-arrow"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></span>
      </button>`;
  }).join('');

  inner.innerHTML = `
    <div class="ledger-heading">Premium Tools</div>
    <p class="ledger-sub">${isPaidUser
      ? 'Your unlocked workspace for deeper financial planning.'
      : 'Budget Planner and Spendings — with custom categories, monthly breakdowns, and an archive of past periods — are part of full access.'}</p>
    <div class="ledger-tool-list">${itemsHtml}</div>
    ${isPaidUser ? '' : '<button type="button" class="ledger-lock-cta" id="ledger-unlock-cta">Unlock full access — $10</button>'}
    <div class="ledger-feedback-section">
      <button type="button" class="ledger-feedback-btn" id="send-feedback-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span>Send feedback</span>
      </button>
    </div>
    <div class="ledger-future-hint">More premium tools are on the way</div>
  `;

  inner.querySelectorAll('.ledger-tool-item[data-href]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const isLocked = !isPaidUser && !TRIAL_COVERED_TOOL_IDS.includes(btn.dataset.toolId);
      if (isLocked) { await redirectToCheckout(currentUserId, currentUserEmail); return; }
      window.location.href = btn.dataset.href;
    });
  });

  if (!isPaidUser) {
    const unlockBtn = document.getElementById('ledger-unlock-cta');
    if (unlockBtn) unlockBtn.addEventListener('click', () => redirectToCheckout(currentUserId, currentUserEmail));
  }

  document.getElementById('send-feedback-btn').addEventListener('click', () => {
    closeLedgerMenu();
    document.getElementById('feedback-overlay').classList.add('open');
    renderFeedbackForm();
  });
}

function closeLedgerMenu() {
  const dd = document.getElementById('ledger-dropdown');
  const btn = document.getElementById('ledger-menu-btn');
  if (dd) dd.classList.remove('open');
  if (btn) btn.classList.remove('stamp');
}

function setupLedgerMenu() {
  const btn = document.getElementById('ledger-menu-btn');
  const dd = document.getElementById('ledger-dropdown');
  const gearBtn = document.getElementById('settings-gear');
  const gearDropdown = document.getElementById('settings-dropdown');

  renderLedgerMenu();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    gearDropdown.classList.remove('open');
    gearBtn.classList.remove('spin');
    const opening = !dd.classList.contains('open');
    dd.classList.toggle('open', opening);
    if (opening) {
      renderLedgerMenu();
      btn.classList.remove('stamp');
      void btn.offsetWidth;
      btn.classList.add('stamp');
    }
  });

  dd.addEventListener('click', (e) => e.stopPropagation());
}

// ================= TWO-FACTOR AUTHENTICATION =================
// Real end-user MFA via Supabase Auth's native TOTP support.
// requireMfaVerified(gate) is awaited at the very top of init(), before
// any page content renders — so Connections genuinely cannot be entered
// (not just "Connect with Plaid," the whole tab) until the user has
// both enrolled AND verified a second factor for this session (AAL2).
// When gate=true, the overlay can't be dismissed without completing it.
let mfaEnrollFactorId = null;
let mfaGateActive = false;
let mfaResolveQueue = [];

async function getMfaLevel() {
  const { data, error } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) { console.error(error); return { currentLevel: 'aal1', nextLevel: 'aal1' }; }
  return data;
}

// Resolves once the session reaches AAL2. If already there, resolves
// immediately without ever showing the overlay. Otherwise opens it in
// the right state and waits — this function does not return until the
// user has actually completed verification.
async function requireMfaVerified(gate) {
  const { currentLevel, nextLevel } = await getMfaLevel();
  if (currentLevel === 'aal2') return true;

  openMfaOverlay(gate);
  if (nextLevel === 'aal2') {
    await renderMfaVerifyForm();
  } else {
    await renderMfaEnrollStart();
  }

  return new Promise(resolve => { mfaResolveQueue.push(resolve); });
}

function resolveMfaGate(success) {
  mfaResolveQueue.forEach(r => r(success));
  mfaResolveQueue = [];
}

function openMfaOverlay(gate) {
  mfaGateActive = !!gate;
  const overlay = document.getElementById('mfa-overlay');
  overlay.classList.add('open');
  overlay.classList.toggle('mfa-gated', mfaGateActive);
}
// Dismisses the overlay without completing verification. Always
// available via the Cancel button, even during a required gate —
// there's no reason to trap someone in a broken or unwanted flow.
// Backdrop-click and the × button still respect the gate, so an
// accidental click elsewhere can't dismiss a required step.
function cancelMfaOverlay() {
  mfaGateActive = false;
  document.getElementById('mfa-overlay').classList.remove('open', 'mfa-gated');
  mfaEnrollFactorId = null;
  resolveMfaGate(false);
}
function closeMfaOverlay() {
  if (mfaGateActive) return; // can't be dismissed — must complete verification
  document.getElementById('mfa-overlay').classList.remove('open');
  mfaEnrollFactorId = null;
}

function mfaQrDataUri(qrRaw) {
  if (!qrRaw) return '';
  // Handle either shape Supabase might hand back, and don't just trust
  // a "data:" prefix blindly — some versions return a data: URI whose
  // payload is still raw, unescaped SVG markup (literal quotes and
  // angle brackets), which corrupts the surrounding HTML exactly like
  // unencoded raw SVG does. Check the actual payload, not just the
  // prefix, and re-encode it if it isn't actually safe.
  if (qrRaw.startsWith('data:')) {
    const commaIndex = qrRaw.indexOf(',');
    const payload = commaIndex >= 0 ? qrRaw.slice(commaIndex + 1) : '';
    if (payload.includes('<') || payload.includes('"')) {
      return 'data:image/svg+xml;utf-8,' + encodeURIComponent(payload);
    }
    return qrRaw; // genuinely already safe (percent-encoded or base64)
  }
  return 'data:image/svg+xml;utf-8,' + encodeURIComponent(qrRaw);
}

function mfaQrFrameHtml(qrSvg, secret) {
  const qrDataUri = mfaQrDataUri(qrSvg);
  return `
    <div class="mfa-qr-frame">
      <span class="mfa-qr-label">Scan with your authenticator app</span>
      <div class="mfa-qr-inner">
        <img src="${qrDataUri}" alt="Two-factor authentication QR code"
             onerror="this.style.display='none'; document.getElementById('mfa-qr-fallback').style.display='block';" />
        <p class="mfa-qr-fallback" id="mfa-qr-fallback" style="display:none;">Couldn't load the QR code — use the code below to set up manually instead.</p>
      </div>
      <div class="mfa-qr-secret-wrap">
        <span class="mfa-qr-secret-label">Can't scan it? Enter manually</span>
        <code class="mfa-qr-secret-code">${secret}</code>
      </div>
    </div>`;
}

// Prompts for a code from an already-verified factor and resolves
// true/false — used before removing a factor, since Supabase requires
// AAL2 to do that. Deliberately separate from requireMfaVerified(),
// which closes the whole overlay on success (right for "gate before
// navigating away", wrong here where the goal is to stay put and
// continue the removal).
function verifyFactorInline(factorId) {
  return new Promise((resolve) => {
    const body = document.getElementById('mfa-modal-body');
    body.innerHTML = `
      <p class="mfa-modal-sub">Enter your authenticator code to confirm removal.</p>
      <div class="mfa-field">
        <label for="mfa-remove-verify-code">6-digit code</label>
        <input type="text" id="mfa-remove-verify-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" />
      </div>
      <button type="button" id="mfa-remove-verify-btn" class="mfa-verify-btn">Confirm</button>
      <p class="mfa-modal-sub" id="mfa-remove-verify-error" style="color:var(--error); display:none;"></p>
    `;
    document.getElementById('mfa-remove-verify-btn').addEventListener('click', async () => {
      const code = document.getElementById('mfa-remove-verify-code').value.trim();
      const errorEl = document.getElementById('mfa-remove-verify-error');
      errorEl.style.display = 'none';
      if (!code) return;

      const { data: challengeData, error: challengeError } = await supabaseClient.auth.mfa.challenge({ factorId });
      if (challengeError) { errorEl.textContent = challengeError.message; errorEl.style.display = 'block'; resolve(false); return; }

      const { error: verifyError } = await supabaseClient.auth.mfa.verify({ factorId, challengeId: challengeData.id, code });
      if (verifyError) { errorEl.textContent = 'Incorrect code — try again.'; errorEl.style.display = 'block'; return; }

      resolve(true);
    });
  });
}

async function renderMfaManage() {
  const body = document.getElementById('mfa-modal-body');
  const { data, error } = await supabaseClient.auth.mfa.listFactors();
  if (error) { body.innerHTML = `<p class="mfa-modal-sub">Could not load your two-factor settings: ${error.message}</p>`; return; }

  const totpFactors = (data.totp || []).filter(f => f.status === 'verified');

  if (!totpFactors.length) {
    await renderMfaEnrollStart();
    return;
  }

  body.innerHTML = `
    <p class="mfa-modal-sub">Two-factor authentication is <strong style="color:var(--emerald-bright);">enabled</strong>. It's required to open Connections and to link accounts via Plaid.</p>
    <div class="mfa-factor-list">
      ${totpFactors.map(f => `
        <div class="mfa-factor-row">
          <span>Authenticator app${f.friendly_name ? ' — ' + f.friendly_name : ''}</span>
          <button type="button" class="mfa-remove-factor-btn" data-id="${f.id}">Remove</button>
        </div>
      `).join('')}
    </div>
  `;

  document.querySelectorAll('.mfa-remove-factor-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm("Remove this authenticator? You won't be able to open Connections or connect Plaid accounts until you enroll a new one.")) return;

      // Supabase requires the session to already be AAL2 (a completed
      // 2FA challenge this session) before it'll let you remove a
      // verified factor — a safeguard so removal can't happen without
      // proving you still have access to it. If this session hasn't
      // done that yet (e.g. you came straight from Dashboard/Log/
      // Budget, where MFA isn't required to just use the page),
      // prompt for the code inline before actually removing anything.
      const factorId = btn.dataset.id;
      const { currentLevel } = await getMfaLevel();
      if (currentLevel !== 'aal2') {
        const verified = await verifyFactorInline(factorId);
        if (!verified) { await renderMfaManage(); return; }
      }

      const { error: unenrollError } = await supabaseClient.auth.mfa.unenroll({ factorId });
      if (unenrollError) { alert('Could not remove: ' + unenrollError.message); return; }
      logAuditEvent('mfa_factor_removed', {});
      await renderMfaManage();
    });
  });
}

async function renderMfaEnrollStart() {
  const body = document.getElementById('mfa-modal-body');
  body.innerHTML = `<p class="mfa-modal-sub">Loading enrollment…</p>`;

  // Every open used to call enroll() fresh, which hands back a brand
  // new secret/QR each time — so closing before verifying and
  // reopening orphaned whatever was already scanned into an
  // authenticator app (the old code no longer matched anything).
  // Clean up any unverified attempt left over from a previous
  // open/close first, so each open is a single, clean, working
  // attempt no matter how many times it's been opened before.
  const { data: existingFactors } = await supabaseClient.auth.mfa.listFactors();
  const danglingFactors = (existingFactors?.totp || []).filter(f => f.status === 'unverified');
  for (const f of danglingFactors) {
    await supabaseClient.auth.mfa.unenroll({ factorId: f.id });
  }

  // friendlyName must be unique per user — Supabase defaults it to an
  // empty string when omitted, and rejects a second enroll() with
  // "already exists" once anything (even a since-removed factor) has
  // used that same empty default. Generating a fresh one each time
  // sidesteps that entirely, regardless of whether the cleanup above
  // fully succeeded.
  const { data, error } = await supabaseClient.auth.mfa.enroll({ factorType: 'totp', issuer: 'Arko Finance', friendlyName: 'totp-' + Date.now() });
  if (error) {
    body.innerHTML = `<p class="mfa-modal-sub">Could not start enrollment: ${error.message}</p>`;
    return;
  }
  mfaEnrollFactorId = data.id;

  body.innerHTML = `
    <p class="mfa-modal-sub">Two-factor authentication is required to open Connections. Scan this code with an authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it shows.</p>
    ${mfaQrFrameHtml(data.totp.qr_code, data.totp.secret)}
    <div class="mfa-field">
      <label for="mfa-verify-code">6-digit code</label>
      <input type="text" id="mfa-verify-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" />
    </div>
    <button type="button" id="mfa-enroll-verify-btn" class="mfa-verify-btn" style="margin-top:6px;">Verify & Enable</button>
    <p class="mfa-modal-sub" id="mfa-enroll-error" style="color:var(--liability-bright); display:none;"></p>
  `;

  document.getElementById('mfa-enroll-verify-btn').addEventListener('click', async () => {
    const code = document.getElementById('mfa-verify-code').value.trim();
    const errorEl = document.getElementById('mfa-enroll-error');
    errorEl.style.display = 'none';
    if (!code) return;

    const { data: challengeData, error: challengeError } = await supabaseClient.auth.mfa.challenge({ factorId: mfaEnrollFactorId });
    if (challengeError) { errorEl.textContent = challengeError.message; errorEl.style.display = 'block'; return; }

    const { error: verifyError } = await supabaseClient.auth.mfa.verify({
      factorId: mfaEnrollFactorId,
      challengeId: challengeData.id,
      code,
    });
    if (verifyError) { errorEl.textContent = 'Incorrect code — try again.'; errorEl.style.display = 'block'; return; }

    logAuditEvent('mfa_enrolled', {});
    mfaEnrollFactorId = null;
    mfaGateActive = false;
    document.getElementById('mfa-overlay').classList.remove('open', 'mfa-gated');
    resolveMfaGate(true);
  });
}

async function renderMfaVerifyForm() {
  const body = document.getElementById('mfa-modal-body');
  const { data } = await supabaseClient.auth.mfa.listFactors();
  const factor = (data?.totp || []).find(f => f.status === 'verified');
  if (!factor) { await renderMfaEnrollStart(); return; }

  body.innerHTML = `
    <p class="mfa-modal-sub">Enter the code from your authenticator app to continue.</p>
    <div class="mfa-field">
      <label for="mfa-verify-code">6-digit code</label>
      <input type="text" id="mfa-verify-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" />
    </div>
    <button type="button" id="mfa-session-verify-btn" class="mfa-verify-btn" style="margin-top:6px;">Verify</button>
    <p class="mfa-modal-sub" id="mfa-verify-error" style="color:var(--liability-bright); display:none;"></p>
  `;

  document.getElementById('mfa-session-verify-btn').addEventListener('click', async () => {
    const code = document.getElementById('mfa-verify-code').value.trim();
    const errorEl = document.getElementById('mfa-verify-error');
    errorEl.style.display = 'none';
    if (!code) return;

    const { data: challengeData, error: challengeError } = await supabaseClient.auth.mfa.challenge({ factorId: factor.id });
    if (challengeError) { errorEl.textContent = challengeError.message; errorEl.style.display = 'block'; return; }

    const { error: verifyError } = await supabaseClient.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challengeData.id,
      code,
    });
    if (verifyError) { errorEl.textContent = 'Incorrect code — try again.'; errorEl.style.display = 'block'; return; }

    mfaGateActive = false;
    document.getElementById('mfa-overlay').classList.remove('open', 'mfa-gated');
    resolveMfaGate(true);
  });
}

function setupMfaOverlay() {
  document.getElementById('manage-mfa-btn').addEventListener('click', () => {
    document.getElementById('settings-dropdown').classList.remove('open');
    openMfaOverlay(false);
    renderMfaManage();
  });
  document.getElementById('mfa-close').addEventListener('click', closeMfaOverlay);
  document.getElementById('mfa-cancel-btn').addEventListener('click', cancelMfaOverlay);
  document.getElementById('mfa-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'mfa-overlay') closeMfaOverlay();
  });
}

// ================= RECENT ACTIVITY =================
// Makes the audit_log table (written throughout this app for security
// events) visible to the person it belongs to, rather than existing
// only as a compliance answer nobody ever sees working.
const ACTIVITY_LABELS = {
  plaid_item_linked: (d) => `Connected ${d.institution_name || 'an account'} via Plaid`,
  linked_account_removed: (d) => `Removed ${d.institution_name || 'an account'}${d.account_type ? ' (' + d.account_type + ')' : ''}`,
  all_linked_accounts_removed: (d) => `Removed all linked accounts (${d.count ?? '?'})`,
  recurring_review_approved: (d) => `Added ${d.merchant_name || 'a transaction'} to ${d.mapped_line_name || d.mapped_cat || 'your budget'}`,
  recurring_review_dismissed: (d) => `Dismissed a suggested transaction${d.merchant_name ? ' — ' + d.merchant_name : ''}`,
  recurring_stream_mapped: (d) => `Mapped a recurring ${d.mapped_cat || 'transaction'} to your budget`,
  mfa_enrolled: () => `Enabled two-factor authentication`,
  mfa_factor_removed: () => `Removed a two-factor authenticator`,
  plaid_item_revoked: (d) => `Fully disconnected ${d.institution_name || 'an account'} from Plaid`,
  plaid_item_reconnected: (d) => `Reconnected ${d.institution_name || 'an account'}`,
  account_categorized: () => `Categorized a linked account`,
  category_created: (d) => `Created the "${d.name || 'new'}" category`,
  txn_review_approved: (d) => `Added ${d.merchant_name || 'a transaction'} to ${d.category || 'Dashboard'}`,
  txn_review_dismissed: (d) => `Dismissed a suggested transaction${d.merchant_name ? ' — ' + d.merchant_name : ''}`,
  budget_preset_created: (d) => `Set up auto-filing for ${d.plaid_category ? d.plaid_category.toLowerCase().replace(/_/g,' ') : 'a category'} → ${d.target_line_name || 'a budget line'}`,
  transaction_history_cleared: () => `Cleared transaction history`,
  envelope_created: (d) => `Set aside ${d.amount ? money(d.amount) : 'an amount'} for ${d.category || 'a category'}`,
  envelope_adjusted: (d) => `Updated the ${d.category || ''} set-aside amount to ${d.amount ? money(d.amount) : '?'}`,
  envelope_removed: (d) => `Removed the ${d.category || ''} set-aside amount`,
};

function formatActivityEvent(row) {
  const formatter = ACTIVITY_LABELS[row.event_type];
  const label = formatter ? formatter(row.detail || {}) : row.event_type.replace(/_/g, ' ');
  const when = new Date(row.created_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  return { label, when };
}

async function renderActivityPanel() {
  const body = document.getElementById('activity-modal-body');
  body.innerHTML = `<p class="mfa-modal-sub">Loading…</p>`;

  const { data, error } = await supabaseClient
    .from('audit_log')
    .select('*')
    .eq('user_id', currentUserId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) { body.innerHTML = `<p class="mfa-modal-sub">Could not load activity: ${error.message}</p>`; return; }
  if (!data.length) { body.innerHTML = `<p class="mfa-modal-sub">No activity yet.</p>`; return; }

  body.innerHTML = `
    <div class="activity-list">
      ${data.map(row => {
        const { label, when } = formatActivityEvent(row);
        return `<div class="activity-row"><span class="activity-label">${label}</span><span class="activity-when">${when}</span></div>`;
      }).join('')}
    </div>
  `;
}

function setupActivityPanel() {
  document.getElementById('view-activity-btn').addEventListener('click', () => {
    document.getElementById('settings-dropdown').classList.remove('open');
    document.getElementById('activity-overlay').classList.add('open');
    renderActivityPanel();
  });
  document.getElementById('activity-close').addEventListener('click', () => {
    document.getElementById('activity-overlay').classList.remove('open');
  });
  document.getElementById('activity-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'activity-overlay') document.getElementById('activity-overlay').classList.remove('open');
  });
}

// ================= CATEGORY MAPPING =================
// Convenience-first: opens on a simple one-tap choice with a smart
// suggestion already highlighted. Splitting across categories is a
// deliberate extra step ("Split this account across categories
// instead"), never the default view — most people never need it.
let categoryMappingAccountId = null;

function closeCategoryOverlay() {
  document.getElementById('category-overlay').classList.remove('open');
  categoryMappingAccountId = null;
}

function openCategoryMapping(accountId) {
  categoryMappingAccountId = accountId;
  document.getElementById('category-overlay').classList.add('open');

  const acct = accounts.find(a => a.id === accountId);
  if (acct && acct.account_type === 'credit_card') {
    renderCreditCardCategoryBlock();
    return;
  }

  renderCategorySimpleMode();
}

// Credit cards are already tracked as a liability (in "Owed", part of
// net worth) and as a transaction source — mapping one to a spending
// category too would double-count the same debt as if it were money
// you have, not money you owe.
function renderCreditCardCategoryBlock() {
  const acct = accounts.find(a => a.id === categoryMappingAccountId);
  if (!acct) { closeCategoryOverlay(); return; }
  const body = document.getElementById('category-modal-body');
  const displayName = (acct.nickname || acct.institution_name || 'this card').replace(/</g, '&lt;');
  const currentCatId = acct.paid_from_category_id || '';

  body.innerHTML = `
    <p class="mfa-modal-sub">Credit cards aren't mapped to a category — a balance owed isn't money you have, so counting it toward a category would double it against Liabilities.</p>
    <p class="mfa-modal-sub">But that debt is real. Which category actually pays <strong style="color:var(--tan);">${displayName}</strong> off? That category's total will show the balance subtracted, so it reflects money that's already spoken for.</p>
    <div class="mfa-field">
      <label for="cc-paid-from-select">Paid from</label>
      <select id="cc-paid-from-select">
        <option value="">Not linked — count separately in Liabilities only</option>
        ${categories.map(c => `<option value="${c.id}" ${c.id === currentCatId ? 'selected' : ''}>${c.name.replace(/</g,'&lt;')}</option>`).join('')}
      </select>
    </div>
    <button type="button" class="mfa-verify-btn" id="cc-paid-from-save-btn" style="margin-top:12px;">Save</button>
  `;

  document.getElementById('cc-paid-from-save-btn').addEventListener('click', async () => {
    const newCatId = document.getElementById('cc-paid-from-select').value || null;
    const { error } = await supabaseClient.from('linked_accounts').update({ paid_from_category_id: newCatId }).eq('id', acct.id);
    if (error) { alert('Could not save: ' + error.message); return; }
    const catName = newCatId ? (categories.find(c => c.id === newCatId)?.name || '') : null;
    logAuditEvent('credit_card_linked_to_category', { institution_name: acct.institution_name, category: catName });
    closeCategoryOverlay();
    await loadAccounts();
  });
}

function renderCategorySimpleMode() {
  const acct = accounts.find(a => a.id === categoryMappingAccountId);
  if (!acct) { closeCategoryOverlay(); return; }
  const body = document.getElementById('category-modal-body');
  const suggested = suggestCategoryName(acct.account_type);
  const currentSplits = accountSplits.filter(s => s.linked_account_id === categoryMappingAccountId && s.split_type !== 'envelope');
  const envelopes = accountSplits.filter(s => s.linked_account_id === categoryMappingAccountId && s.split_type === 'envelope');
  const currentSingleCatId = currentSplits.length === 1 && Number(currentSplits[0].split_percent) === 100 ? currentSplits[0].category_id : null;
  const displayName = (acct.nickname || acct.institution_name || 'this account').replace(/</g, '&lt;');

  const envelopesHtml = envelopes.length ? `
    <div class="envelope-list">
      ${envelopes.map(e => {
        const cat = categories.find(c => c.id === e.category_id);
        return `
          <div class="envelope-row">
            <span class="envelope-name">${(cat ? cat.name : 'Category').replace(/</g,'&lt;')}</span>
            <span class="envelope-amount">${money(e.envelope_balance)} set aside</span>
            <button type="button" class="envelope-topup-btn" data-id="${e.id}" title="Add or remove money">Adjust</button>
            <button type="button" class="envelope-remove-btn" data-id="${e.id}" title="Remove this envelope">×</button>
          </div>`;
      }).join('')}
    </div>` : '';

  body.innerHTML = `
    <p class="mfa-modal-sub">Which category should <strong style="color:var(--tan);">${displayName}</strong> count toward on your Dashboard?</p>
    <div class="category-choice-grid">
      ${categories.map(c => {
        const isSuggested = c.name === suggested && !currentSingleCatId;
        const isCurrent = c.id === currentSingleCatId;
        return `<button type="button" class="category-choice-btn${isCurrent || isSuggested ? ' suggested' : ''}" data-cat-id="${c.id}">${c.name.replace(/</g,'&lt;')}${isCurrent ? ' ✓' : ''}</button>`;
      }).join('')}
    </div>
    <button type="button" class="category-text-link" id="category-add-new-btn">+ Add a new category</button>
    <button type="button" class="category-text-link" id="category-split-link">Split this account across categories instead</button>
    ${currentSplits.length ? `<button type="button" class="category-text-link category-clear-link" id="category-clear-btn">Remove categorization</button>` : ''}

    <div class="envelope-section">
      <p class="envelope-section-label">Set aside money within this account</p>
      <p class="mfa-modal-sub" style="margin-bottom:10px;">For money that stays in this account but you mentally set aside for something else — like $200 of checking earmarked for weekly expenses. Tracked separately, doesn't affect this account's main category above.</p>
      ${envelopesHtml}
      <button type="button" class="category-text-link" id="envelope-add-btn">+ Set aside an amount for another category</button>
    </div>
  `;

  body.querySelectorAll('.category-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => assignSingleCategory(btn.dataset.catId));
  });
  document.getElementById('category-add-new-btn').addEventListener('click', renderAddCategoryForm);
  document.getElementById('category-split-link').addEventListener('click', renderCategorySplitMode);
  const clearBtn = document.getElementById('category-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', clearCategoryMapping);

  document.getElementById('envelope-add-btn').addEventListener('click', renderEnvelopeCreateForm);
  body.querySelectorAll('.envelope-topup-btn').forEach(btn => {
    btn.addEventListener('click', () => renderEnvelopeAdjustForm(btn.dataset.id));
  });
  body.querySelectorAll('.envelope-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeEnvelope(btn.dataset.id));
  });
}

// ---------- envelopes ----------
function renderEnvelopeCreateForm() {
  const body = document.getElementById('category-modal-body');
  const existingEnvelopeCatIds = accountSplits
    .filter(s => s.linked_account_id === categoryMappingAccountId && s.split_type === 'envelope')
    .map(s => s.category_id);
  const eligibleCategories = categories.filter(c => !existingEnvelopeCatIds.includes(c.id));

  if (!eligibleCategories.length) {
    body.innerHTML = `<p class="mfa-modal-sub">Every category already has an envelope on this account. <button type="button" class="category-text-link" id="envelope-back-btn" style="display:inline;padding:0;">Go back</button></p>`;
    document.getElementById('envelope-back-btn').addEventListener('click', renderCategorySimpleMode);
    return;
  }

  body.innerHTML = `
    <p class="mfa-modal-sub">Set aside a specific dollar amount for a category, without changing this account's main category.</p>
    <div class="mfa-field">
      <label for="envelope-cat-select">Category</label>
      <select id="envelope-cat-select">
        ${eligibleCategories.map(c => `<option value="${c.id}">${c.name.replace(/</g,'&lt;')}</option>`).join('')}
      </select>
    </div>
    <div class="mfa-field" style="margin-top:12px;">
      <label for="envelope-amount-input">Amount to set aside</label>
      <input type="number" id="envelope-amount-input" min="0.01" step="0.01" placeholder="200.00" style="text-align:left; letter-spacing:normal; font-family:'Public Sans',sans-serif;" />
    </div>
    <button type="button" class="mfa-verify-btn" id="envelope-save-btn" style="margin-top:12px;">Set aside this amount</button>
    <button type="button" class="category-text-link" id="envelope-cancel-btn">Cancel</button>
  `;

  document.getElementById('envelope-cancel-btn').addEventListener('click', renderCategorySimpleMode);
  document.getElementById('envelope-save-btn').addEventListener('click', async () => {
    const categoryId = document.getElementById('envelope-cat-select').value;
    const amount = round2(Math.abs(parseFloat(document.getElementById('envelope-amount-input').value) || 0));
    if (!amount) { alert('Enter an amount greater than $0.'); return; }
    if (blockIfCategoryHasManualAmount(categoryId)) return;

    const { error } = await supabaseClient.from('account_category_splits').insert({
      user_id: currentUserId,
      linked_account_id: categoryMappingAccountId,
      category_id: categoryId,
      split_type: 'envelope',
      envelope_balance: amount,
    });
    if (error) { alert('Could not save: ' + error.message); return; }

    const cat = categories.find(c => c.id === categoryId);
    logAuditEvent('envelope_created', { category: cat?.name, amount });
    await loadAccounts();
    openCategoryMapping(categoryMappingAccountId);
  });
}

function renderEnvelopeAdjustForm(splitId) {
  const envelope = accountSplits.find(s => s.id === splitId);
  if (!envelope) { renderCategorySimpleMode(); return; }
  const cat = categories.find(c => c.id === envelope.category_id);
  const body = document.getElementById('category-modal-body');

  body.innerHTML = `
    <p class="mfa-modal-sub">Currently <strong style="color:var(--tan);">${money(envelope.envelope_balance)}</strong> set aside for ${(cat ? cat.name : 'this category').replace(/</g,'&lt;')}.</p>
    <div class="mfa-field">
      <label for="envelope-adjust-input">New amount</label>
      <input type="number" id="envelope-adjust-input" min="0" step="0.01" value="${envelope.envelope_balance}" style="text-align:left; letter-spacing:normal; font-family:'Public Sans',sans-serif;" />
    </div>
    <p class="mfa-modal-sub" style="margin-top:6px;">Set this to whatever the real, current set-aside amount is — for example, after adding this week's amount, or after spending some of it outside of an approved Dashboard transaction.</p>
    <button type="button" class="mfa-verify-btn" id="envelope-adjust-save-btn" style="margin-top:12px;">Save</button>
    <button type="button" class="category-text-link" id="envelope-adjust-cancel-btn">Cancel</button>
  `;

  document.getElementById('envelope-adjust-cancel-btn').addEventListener('click', renderCategorySimpleMode);
  document.getElementById('envelope-adjust-save-btn').addEventListener('click', async () => {
    const newAmount = round2(Math.abs(parseFloat(document.getElementById('envelope-adjust-input').value) || 0));
    const { error } = await supabaseClient.from('account_category_splits').update({ envelope_balance: newAmount }).eq('id', splitId);
    if (error) { alert('Could not save: ' + error.message); return; }
    logAuditEvent('envelope_adjusted', { category: cat?.name, amount: newAmount });
    await loadAccounts();
    openCategoryMapping(categoryMappingAccountId);
  });
}

async function removeEnvelope(splitId) {
  const envelope = accountSplits.find(s => s.id === splitId);
  if (!envelope) return;
  const cat = categories.find(c => c.id === envelope.category_id);
  if (!confirm(`Remove the ${cat ? cat.name : ''} envelope on this account? This only stops tracking it — doesn't move any real money.`)) return;
  const { error } = await supabaseClient.from('account_category_splits').delete().eq('id', splitId);
  if (error) { alert('Could not remove: ' + error.message); return; }
  logAuditEvent('envelope_removed', { category: cat?.name });
  await loadAccounts();
  openCategoryMapping(categoryMappingAccountId);
}

async function assignSingleCategory(categoryId) {
  if (blockIfCategoryHasManualAmount(categoryId)) return;
  await supabaseClient.from('account_category_splits').delete().eq('linked_account_id', categoryMappingAccountId).eq('split_type', 'percent');
  const { error } = await supabaseClient.from('account_category_splits').insert({
    user_id: currentUserId, linked_account_id: categoryMappingAccountId, category_id: categoryId, split_percent: 100, split_type: 'percent',
  });
  if (error) { alert('Could not save: ' + error.message); return; }
  logAuditEvent('account_categorized', {});
  closeCategoryOverlay();
  await loadAccounts();
}

async function clearCategoryMapping() {
  await supabaseClient.from('account_category_splits').delete().eq('linked_account_id', categoryMappingAccountId).eq('split_type', 'percent');
  closeCategoryOverlay();
  await loadAccounts();
}

function renderAddCategoryForm() {
  const body = document.getElementById('category-modal-body');
  body.innerHTML = `
    <p class="mfa-modal-sub">What should this category be called?</p>
    <div class="mfa-field">
      <label for="new-category-name">Category name</label>
      <input type="text" id="new-category-name" placeholder="e.g. Emergency Fund" maxlength="30" style="text-align:left; letter-spacing:normal; font-family:'Public Sans',sans-serif; text-transform:none;" />
    </div>
    <button type="button" class="mfa-verify-btn" id="save-new-category-btn">Add category</button>
    <button type="button" class="category-text-link" id="cancel-add-category-btn">Cancel</button>
  `;
  document.getElementById('new-category-name').focus();
  document.getElementById('save-new-category-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-category-name').value.trim();
    if (!name) return;
    const accentPalette = ['sage', 'blue', 'coral', 'gold', 'violet', 'teal'];
    const accent = accentPalette[categories.length % accentPalette.length];
    const { data, error } = await supabaseClient.from('budget_categories').insert({
      user_id: currentUserId, name, accent, is_default: false, sort_order: categories.length,
    }).select().maybeSingle();
    if (error) { alert('Could not add category: ' + error.message); return; }
    categories.push(data);
    logAuditEvent('category_created', { name });
    renderCategorySimpleMode();
  });
  document.getElementById('cancel-add-category-btn').addEventListener('click', renderCategorySimpleMode);
}

function renderCategorySplitMode() {
  const acct = accounts.find(a => a.id === categoryMappingAccountId);
  if (!acct) { closeCategoryOverlay(); return; }
  const currentSplits = accountSplits.filter(s => s.linked_account_id === categoryMappingAccountId && s.split_type !== 'envelope');
  const body = document.getElementById('category-modal-body');
  const displayName = (acct.nickname || acct.institution_name || 'this account').replace(/</g, '&lt;');

  body.innerHTML = `
    <p class="mfa-modal-sub">Split <strong style="color:var(--tan);">${displayName}</strong> across categories by percentage.</p>
    <div class="category-split-list">
      ${categories.map(c => {
        const existing = currentSplits.find(s => s.category_id === c.id);
        return `<div class="category-split-row">
          <span class="category-split-name">${c.name.replace(/</g,'&lt;')}</span>
          <input type="number" class="category-split-input" data-cat-id="${c.id}" min="0" max="100" value="${existing ? existing.split_percent : 0}" />
          <span class="category-split-pct-sign">%</span>
        </div>`;
      }).join('')}
    </div>
    <div class="category-split-total" id="category-split-total">0% allocated</div>
    <button type="button" class="mfa-verify-btn" id="save-split-btn">Save split</button>
    <button type="button" class="category-text-link" id="back-to-simple-btn">Back</button>
  `;

  function updateTotal() {
    let total = 0;
    body.querySelectorAll('.category-split-input').forEach(i => { total += Number(i.value) || 0; });
    const totalEl = document.getElementById('category-split-total');
    totalEl.textContent = total > 100
      ? `${total}% — that's over 100%, adjust before saving`
      : total === 100
        ? `100% allocated — all set`
        : `${total}% allocated — ${100 - total}% left unassigned`;
    totalEl.classList.toggle('over', total > 100);
  }
  body.querySelectorAll('.category-split-input').forEach(input => input.addEventListener('input', updateTotal));
  updateTotal();

  document.getElementById('back-to-simple-btn').addEventListener('click', renderCategorySimpleMode);
  document.getElementById('save-split-btn').addEventListener('click', async () => {
    let total = 0;
    const rows = [];
    body.querySelectorAll('.category-split-input').forEach(i => {
      const pct = Number(i.value) || 0;
      total += pct;
      if (pct > 0) rows.push({ user_id: currentUserId, linked_account_id: categoryMappingAccountId, category_id: i.dataset.catId, split_percent: pct, split_type: 'percent' });
    });
    if (total > 100) { alert("That adds up to more than 100% — adjust the numbers before saving."); return; }
    if (rows.some(r => blockIfCategoryHasManualAmount(r.category_id))) return;

    await supabaseClient.from('account_category_splits').delete().eq('linked_account_id', categoryMappingAccountId).eq('split_type', 'percent');
    if (rows.length) {
      const { error } = await supabaseClient.from('account_category_splits').insert(rows);
      if (error) { alert('Could not save: ' + error.message); return; }
    }
    logAuditEvent('account_categorized', { split: true });
    closeCategoryOverlay();
    await loadAccounts();
  });
}

function setupCategoryOverlay() {
  document.getElementById('category-close').addEventListener('click', closeCategoryOverlay);
  document.getElementById('category-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'category-overlay') closeCategoryOverlay();
  });
}

// ================= MANAGE CATEGORIES =================
// Rename or remove any category, default or custom. Removing one
// never touches the underlying accounts — they just fall back to
// "Tap to categorize" again, same as if they'd never been mapped.
function renderManageCategories() {
  const body = document.getElementById('manage-categories-body');
  body.innerHTML = `
    <p class="mfa-modal-sub">Rename or remove a category. Removing one won't touch any accounts — they'll just show as uncategorized again.</p>
    <div class="manage-cat-list">
      ${categories.map(c => `
        <div class="manage-cat-row">
          <input type="text" class="manage-cat-name-input" data-id="${c.id}" data-original="${c.name.replace(/"/g,'&quot;')}" value="${c.name.replace(/"/g,'&quot;')}" maxlength="30" />
          <button type="button" class="manage-cat-save-btn" data-id="${c.id}" style="display:none;">Save</button>
          <button type="button" class="manage-cat-delete-btn" data-id="${c.id}">Remove</button>
        </div>
      `).join('')}
    </div>
    <div class="mfa-field" style="margin-top:14px;">
      <label for="new-manage-category-name">Add a new category</label>
      <div style="display:flex; gap:8px;">
        <input type="text" id="new-manage-category-name" placeholder="e.g. Emergency Fund" maxlength="30" style="flex:1; text-align:left; letter-spacing:normal; font-family:'Public Sans',sans-serif; text-transform:none;" />
        <button type="button" class="mfa-verify-btn" id="add-manage-category-btn" style="width:auto; padding:0 16px;">Add</button>
      </div>
    </div>
  `;

  body.querySelectorAll('.manage-cat-name-input').forEach(input => {
    input.addEventListener('input', () => {
      const saveBtn = document.querySelector(`.manage-cat-save-btn[data-id="${input.dataset.id}"]`);
      const changed = input.value.trim() && input.value.trim() !== input.dataset.original;
      saveBtn.style.display = changed ? 'inline-block' : 'none';
    });
  });

  body.querySelectorAll('.manage-cat-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const input = document.querySelector(`.manage-cat-name-input[data-id="${btn.dataset.id}"]`);
      const newName = input.value.trim();
      if (!newName) return;
      const { error } = await supabaseClient.from('budget_categories').update({ name: newName }).eq('id', btn.dataset.id);
      if (error) { alert('Could not rename: ' + error.message); return; }
      logAuditEvent('category_renamed', { name: newName });
      await loadCategories();
      renderManageCategories();
      renderAll();
    });
  });

  body.querySelectorAll('.manage-cat-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = categories.find(c => c.id === btn.dataset.id);
      if (!cat) return;
      if (!confirm(`Remove "${cat.name}"? Any accounts mapped to it will become uncategorized.`)) return;
      const { error } = await supabaseClient.from('budget_categories').delete().eq('id', btn.dataset.id);
      if (error) { alert('Could not remove: ' + error.message); return; }
      logAuditEvent('category_deleted', { name: cat.name });
      await loadCategories();
      renderManageCategories();
      renderAll();
    });
  });

  document.getElementById('add-manage-category-btn').addEventListener('click', async () => {
    const nameInput = document.getElementById('new-manage-category-name');
    const name = nameInput.value.trim();
    if (!name) return;
    const accentPalette = ['sage', 'blue', 'coral', 'gold', 'violet', 'teal'];
    const accent = accentPalette[categories.length % accentPalette.length];
    const { error } = await supabaseClient.from('budget_categories').insert({
      user_id: currentUserId, name, accent, is_default: false, sort_order: categories.length,
    });
    if (error) { alert('Could not add category: ' + error.message); return; }
    logAuditEvent('category_created', { name });
    await loadCategories();
    renderManageCategories();
    renderAll();
  });
}

function setupManageCategories() {
  document.getElementById('manage-categories-btn').addEventListener('click', () => {
    document.getElementById('settings-dropdown').classList.remove('open');
    document.getElementById('manage-categories-overlay').classList.add('open');
    renderManageCategories();
  });
  document.getElementById('manage-categories-close').addEventListener('click', () => {
    document.getElementById('manage-categories-overlay').classList.remove('open');
  });
  document.getElementById('manage-categories-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'manage-categories-overlay') document.getElementById('manage-categories-overlay').classList.remove('open');
  });
}

// ================= FEEDBACK =================
function renderFeedbackForm() {
  const body = document.getElementById('feedback-modal-body');
  body.innerHTML = `
    <p class="mfa-modal-sub">Goes straight to the team — bugs, ideas, anything.</p>
    <div class="mfa-field">
      <label for="feedback-name">Name (optional)</label>
      <input type="text" id="feedback-name" placeholder="Your name" style="text-align:left; letter-spacing:normal; font-family:'Public Sans',sans-serif; text-transform:none;" />
    </div>
    <div class="mfa-field" style="margin-top:12px;">
      <label for="feedback-type">Type</label>
      <select id="feedback-type">
        <option value="bug">Bug report</option>
        <option value="improvement">Improvement idea</option>
        <option value="question">Question</option>
        <option value="other">Other</option>
      </select>
    </div>
    <div class="mfa-field" style="margin-top:12px;">
      <label for="feedback-message">What's on your mind?</label>
      <textarea id="feedback-message" rows="5" placeholder="Tell us what happened, or what you'd like to see…" style="width:100%; padding:12px 14px; border-radius:8px; border:1px solid var(--vault-line); background:#0B120F; color:var(--tan); font-size:0.85rem; font-family:'Public Sans',sans-serif; resize:vertical;"></textarea>
    </div>
    <button type="button" class="mfa-verify-btn" id="feedback-send-btn" style="margin-top:14px;">Send feedback</button>
    <p class="mfa-modal-sub" id="feedback-error" style="color:var(--liability-bright); display:none; margin-top:8px;"></p>
  `;

  document.getElementById('feedback-send-btn').addEventListener('click', async () => {
    const name = document.getElementById('feedback-name').value.trim();
    const type = document.getElementById('feedback-type').value;
    const message = document.getElementById('feedback-message').value.trim();
    const errorEl = document.getElementById('feedback-error');
    errorEl.style.display = 'none';

    if (!message) {
      errorEl.textContent = 'Add a message before sending.';
      errorEl.style.display = 'block';
      return;
    }

    const btn = document.getElementById('feedback-send-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
      const res = await fetch('/api/send-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, message, userEmail: currentUserEmail }),
      });
      if (!res.ok) throw new Error('Could not send feedback right now — try again in a bit.');

      const body = document.getElementById('feedback-modal-body');
      body.innerHTML = `<p class="mfa-modal-sub">Thanks — that's on its way to the team.</p>`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Send feedback';
    }
  });
}

function setupFeedback() {
  document.getElementById('feedback-close').addEventListener('click', () => {
    document.getElementById('feedback-overlay').classList.remove('open');
  });
  document.getElementById('feedback-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'feedback-overlay') document.getElementById('feedback-overlay').classList.remove('open');
  });
}

// ================= IDLE SESSION TIMEOUT =================
// 10 minutes of no activity triggers a 60-second countdown warning
// before automatically signing out — this page handles linked
// financial account data, so it gets this even though it's a bit
// more friction than the rest of the app.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_WARNING_MS = 60 * 1000;
let idleTimer = null;
let idleCountdownInterval = null;

function resetIdleTimer() {
  clearTimeout(idleTimer);
  clearInterval(idleCountdownInterval);
  document.getElementById('idle-overlay').classList.remove('open');
  idleTimer = setTimeout(showIdleWarning, IDLE_TIMEOUT_MS - IDLE_WARNING_MS);
}

function showIdleWarning() {
  document.getElementById('idle-overlay').classList.add('open');
  let secondsLeft = IDLE_WARNING_MS / 1000;
  document.getElementById('idle-countdown').textContent = secondsLeft;
  idleCountdownInterval = setInterval(async () => {
    secondsLeft--;
    document.getElementById('idle-countdown').textContent = secondsLeft;
    if (secondsLeft <= 0) {
      clearInterval(idleCountdownInterval);
      await supabaseClient.auth.signOut();
      window.location.href = 'login.html';
    }
  }, 1000);
}

function setupIdleTimeout() {
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
  });
  document.getElementById('idle-stay-btn').addEventListener('click', resetIdleTimer);
  resetIdleTimer();
}

// Escape closes whichever overlay is currently open. The real MFA
// overlay uses its own guarded close (which already refuses to
// dismiss a required/gated step) — every other overlay on this page
// is always freely dismissable. idle-overlay is deliberately
// excluded: it's a security prompt, not something Escape should
// wave away without an actual choice.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const mfaOverlay = document.getElementById('mfa-overlay');
  if (mfaOverlay && mfaOverlay.classList.contains('open')) {
    if (typeof closeMfaOverlay === 'function') closeMfaOverlay();
    return;
  }
  document.querySelectorAll('.mfa-overlay.open, .history-overlay.open, .vault-overlay.open').forEach(el => {
    if (el.id !== 'idle-overlay') el.classList.remove('open');
  });
});

init();