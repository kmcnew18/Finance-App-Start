// ============= AMBIENT LIGHTING =============
// Builds the fixed light layer styled in ambient.css, feeds it scroll
// position/speed, "powers on" cards with a brief neon glow as they
// scroll into view, and adds an on/off switch to the Settings menu.
//
// Preference: cached in localStorage so it applies instantly on every
// page load with no flash, and mirrored to the user's own
// user_metadata (ambient_lighting) so it follows them across devices —
// same storage as the other per-user display toggles. Loaded in <head>
// on every page; everything that touches the DOM waits for it.
//
// Deliberately skipped on the landing page (index), which has its own
// art-directed hero lighting.

(function () {
  var STORAGE_KEY = 'arko_ambient';
  var NEON = '#4FC3E8'; // the wordmark's neon blue — constant everywhere for one shared identity

  // Each page's own accent, so the light pools pick up that page's color.
  var PAGE_ACCENTS = {
    dashboard: '#6E8FA3', log: '#6E8FA3',
    budget: '#E0B96E',
    spending: '#E0806A',
    investments: '#A88FD8',
    savings: '#6EC4B8',
    connections: '#63D9AA',
  };
  var DEFAULT_ACCENT = '#6E8FA3';

  var page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') || 'index';
  if (page === 'index') return;

  var accent = PAGE_ACCENTS[page] || DEFAULT_ACCENT;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function readPref() {
    try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch (e) { return true; }
  }
  function writePref(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch (e) {}
  }

  var enabled = readPref();
  var root = null;

  function build() {
    root = document.createElement('div');
    root.className = 'arko-ambient';
    root.setAttribute('aria-hidden', 'true');
    root.style.setProperty('--amb-accent', accent);
    root.style.setProperty('--amb-neon', NEON);
    root.innerHTML =
      '<div class="arko-ambient-pool p1"></div>' +
      '<div class="arko-ambient-pool p2"></div>' +
      '<div class="arko-ambient-pool p3"></div>' +
      '<div class="arko-ambient-streak s1"></div>' +
      '<div class="arko-ambient-streak s2"></div>' +
      '<div class="arko-ambient-vignette"></div>';
    document.body.insertBefore(root, document.body.firstChild);
    // Next frame so the opacity transition actually plays as a fade-in.
    requestAnimationFrame(function () { applyEnabled(enabled); });
  }

  function applyEnabled(on) {
    enabled = on;
    if (root) root.classList.toggle('on', on);
    var input = document.getElementById('arko-ambient-toggle');
    if (input) input.checked = on;
    if (on) onScroll();
  }

  // ---- scroll → lighting ----
  // One rAF loop that only runs while there's something to animate:
  // starts on scroll, keeps going while scroll "energy" (speed) decays,
  // then stops itself.
  var lastY = 0, lastT = 0, energy = 0, rafId = null;

  function frame(now) {
    var y = window.scrollY || 0;
    var dt = Math.max(16, now - lastT);
    var speed = Math.abs(y - lastY) / dt; // px per ms
    lastY = y; lastT = now;
    energy = Math.max(Math.min(1, speed / 2.2), energy * 0.92);

    var max = document.documentElement.scrollHeight - window.innerHeight;
    var progress = max > 0 ? Math.min(1, y / max) : 0;
    root.style.setProperty('--arko-scroll', y.toFixed(1));
    root.style.setProperty('--arko-progress', progress.toFixed(3));
    root.style.setProperty('--arko-energy', energy.toFixed(3));

    rafId = energy > 0.01 ? requestAnimationFrame(frame) : null;
  }
  function onScroll() {
    if (!root || !enabled || reduceMotion) return;
    if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); }
  }

  // ---- power-on glow as cards scroll into view ----
  // Done with the Web Animations API rather than a CSS class so it
  // layers over each card's own entrance animation instead of
  // replacing it. The start frame is the card's own shadow with two
  // extra glow layers appended — keeping the card's layers first means
  // inset/outset positions line up and the shadow interpolates
  // smoothly back to exactly what it was.
  var LIT_SELECTOR = [
    '.card', '.panel', '.txn-review-section', '.category-panel', '.charts-card',
    '.spend-section', '.spend-total-card', '.inv-ring-card', '.inv-other-panel',
    '.networth-card', '.vault-charts-card', '.account-card', '.sav-goal-card',
  ].join(',');

  function powerOn(el) {
    if (!enabled || reduceMotion || !el.animate) return;
    var cs = getComputedStyle(el);
    var c = (cs.getPropertyValue('--cat-accent') || '').trim() || accent;
    var own = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : '';
    var glow = '0 0 0 1px color-mix(in srgb, ' + c + ' 60%, transparent), 0 0 30px 3px color-mix(in srgb, ' + c + ' 34%, transparent)';
    el.animate(
      [{ boxShadow: own ? own + ', ' + glow : glow }, { boxShadow: own || 'none' }],
      { duration: 1400, easing: 'cubic-bezier(.2,.7,.2,1)' }
    );
  }

  function setupPowerOn() {
    if (!('IntersectionObserver' in window)) return;
    var watched = new WeakSet();
    var reported = new WeakSet();
    // Elements that first appear *already in view* after the page has
    // settled are re-renders in place (e.g. category cards rebuilt on
    // every totals refresh) — those shouldn't flash again. The window
    // opens at the first real power-on, so a slow async page load
    // still gets its entrance.
    var settleDeadline = Infinity;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var el = entry.target;
        var first = !reported.has(el);
        reported.add(el);
        if (!entry.isIntersecting) return;
        io.unobserve(el);
        if (first && performance.now() > settleDeadline) return;
        if (settleDeadline === Infinity) settleDeadline = performance.now() + 1500;
        powerOn(el);
      });
    }, { threshold: 0.15 });

    var pending = false;
    function scan() {
      pending = false;
      document.querySelectorAll(LIT_SELECTOR).forEach(function (el) {
        if (watched.has(el) || el.closest('.mfa-overlay, .vault-overlay, .history-overlay')) return;
        watched.add(el);
        io.observe(el);
      });
    }
    scan();
    new MutationObserver(function () {
      if (!pending) { pending = true; requestAnimationFrame(scan); }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ---- Settings switch ----
  function injectToggle() {
    var dropdown = document.getElementById('settings-dropdown');
    if (!dropdown || document.getElementById('arko-ambient-toggle')) return;

    var divider = document.createElement('div');
    divider.className = 'dropdown-divider';
    var row = document.createElement('div');
    row.className = 'dropdown-toggle-row';
    row.innerHTML =
      '<span class="arko-ambient-toggle-label">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4"></path><circle cx="12" cy="12" r="3.5"></circle></svg>' +
        'Ambient lighting' +
      '</span>' +
      '<label class="switch"><input type="checkbox" id="arko-ambient-toggle" /><span class="switch-slider"></span></label>';
    row.addEventListener('click', function (e) { e.stopPropagation(); });

    var anchor = document.getElementById('help-faq-btn');
    if (anchor && anchor.parentNode === dropdown) {
      anchor.after(divider, row);
    } else {
      dropdown.prepend(row, divider);
    }

    var input = document.getElementById('arko-ambient-toggle');
    input.checked = enabled;
    input.addEventListener('change', function () {
      var on = input.checked;
      applyEnabled(on);
      writePref(on);
      saveToAccount(on);
    });
  }

  // Mirrors the choice to user_metadata. Uses the page's own globals
  // when they exist (supabaseClient is declared on every app page;
  // currentUserMetadata only on some) — and keeps the page's in-memory
  // copy in sync so the next settings save on that page doesn't spread
  // a stale object that's missing this key.
  function saveToAccount(on) {
    if (typeof supabaseClient === 'undefined') return;
    supabaseClient.auth.getSession().then(function (res) {
      var session = res && res.data && res.data.session;
      if (!session) return;
      var base = (typeof currentUserMetadata !== 'undefined' && currentUserMetadata) || session.user.user_metadata || {};
      var next = Object.assign({}, base, { ambient_lighting: on });
      if (typeof currentUserMetadata !== 'undefined') currentUserMetadata = next;
      return supabaseClient.auth.updateUser({ data: next }).then(function (r) {
        if (r && r.data && r.data.user && typeof currentUserMetadata !== 'undefined') {
          currentUserMetadata = r.data.user.user_metadata || next;
        }
      });
    }).catch(function () {});
  }

  // On load, adopt the account's saved choice if it differs from this
  // browser's cache (e.g. it was turned off on another device).
  function syncFromAccount() {
    if (typeof supabaseClient === 'undefined') return;
    supabaseClient.auth.getSession().then(function (res) {
      var session = res && res.data && res.data.session;
      var saved = session && session.user && session.user.user_metadata && session.user.user_metadata.ambient_lighting;
      if (typeof saved === 'boolean' && saved !== enabled) {
        applyEnabled(saved);
        writePref(saved);
      }
    }).catch(function () {});
  }

  function init() {
    lastY = window.scrollY || 0;
    build();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();
    setupPowerOn();
    injectToggle();
    // Page scripts declare supabaseClient after this file loads — wait a
    // tick past DOMContentLoaded so it exists.
    setTimeout(syncFromAccount, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.ArkoAmbient = { set: function (on) { applyEnabled(on); writePref(on); saveToAccount(on); }, isOn: function () { return enabled; } };
})();
