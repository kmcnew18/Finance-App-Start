/* ============= TRIAL ENDING NOTICE =============
   During the last few days of the 14-day trial, Dashboard and
   Connections show a calm notice: when the trial ends, what happens then
   (bank connections are disconnected and the account moves to the free
   plan; manual budgets and the log stay), and a way to see plans.
   Previously the only place the countdown appeared was the paywall —
   easy to miss before connections were removed. "Not now" hides it
   until the next day. The daily job also emails a reminder ~48h out. */
(function () {
  var SHOW_WITHIN_DAYS = 5;
  var DAY = 24 * 60 * 60 * 1000;

  function hiddenToday(uid) {
    try { return localStorage.getItem('arko_trial_notice_hidden:' + uid) === new Date().toDateString(); } catch (e) { return false; }
  }
  function hideToday(uid) {
    try { localStorage.setItem('arko_trial_notice_hidden:' + uid, new Date().toDateString()); } catch (e) {}
  }

  function render(main, uid, end) {
    var msLeft = end - Date.now();
    var daysLeft = Math.ceil(msLeft / DAY);
    var endsToday = new Date(end).toDateString() === new Date().toDateString();
    var when = endsToday ? 'today' : daysLeft <= 1 ? 'tomorrow' : 'in ' + daysLeft + ' days';
    var dateText = new Date(end).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    var urgent = daysLeft <= 1;

    var el = document.createElement('div');
    el.className = 'trial-notice' + (urgent ? ' urgent' : '');
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="trial-notice-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"></path></svg></span>' +
      '<div class="trial-notice-text">' +
        '<span class="trial-notice-title">Your free trial ends ' + when + ' <span class="trial-notice-date">· ' + dateText + '</span></span>' +
        '<span class="trial-notice-sub">After that, connected banks disconnect and your account moves to the free plan. Your manual budgets and log stay exactly as they are.</span>' +
      '</div>' +
      '<div class="trial-notice-actions">' +
        '<button type="button" class="trial-notice-later">Not now</button>' +
        '<button type="button" class="trial-notice-plans">See plans</button>' +
      '</div>';
    main.insertBefore(el, main.firstChild);
    el.querySelector('.trial-notice-plans').addEventListener('click', function () {
      if (window.ArkoTransitions && ArkoTransitions.go) ArkoTransitions.go('paywall.html'); else location.href = 'paywall.html';
    });
    el.querySelector('.trial-notice-later').addEventListener('click', function () {
      hideToday(uid);
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 260);
    });
  }

  function start() {
    var main = document.getElementById('dash-main') || document.getElementById('vault-shell');
    if (!main || typeof supabaseClient === 'undefined') return;
    supabaseClient.auth.getSession().then(function (res) {
      var user = res && res.data && res.data.session && res.data.session.user;
      if (!user || hiddenToday(user.id)) return;
      return supabaseClient.from('user_billing').select('billing_period, trial_end').eq('user_id', user.id).maybeSingle().then(function (r) {
        var b = r && r.data;
        if (!b || b.billing_period !== 'trial') return;
        var end = Date.parse(b.trial_end);
        if (!end || end <= Date.now() || end - Date.now() > SHOW_WITHIN_DAYS * DAY) return;
        render(main, user.id, end); // top of the page content on both pages
      });
    }).catch(function () {});
  }

  if (document.readyState === 'complete') setTimeout(start, 600);
  else window.addEventListener('load', function () { setTimeout(start, 600); });

  // For previewing the design without a real trial: ArkoTrialNotice.preview(daysLeft)
  window.ArkoTrialNotice = {
    preview: function (days) {
      var main = document.getElementById('dash-main') || document.getElementById('vault-shell');
      if (main) render(main, 'preview', Date.now() + (days || 3) * DAY - 60000);
    },
  };
})();
