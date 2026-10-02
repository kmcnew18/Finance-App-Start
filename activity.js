/* ============= ACTIVITY HEARTBEAT =============
   Records that the signed-in user opened Arko (user_metadata.last_active_at),
   at most once every 12 hours per browser. The daily maintenance job
   (lib/maintenance.js) uses it to tell an account that's in use from
   one that's been abandoned while its bank connections keep syncing —
   sessions stay open between visits, so the last password sign-in
   alone isn't a reliable signal. Sends only that one key; Supabase
   merges it into the existing metadata. */
(function () {
  var EVERY_MS = 12 * 60 * 60 * 1000;
  function stamp() {
    if (typeof supabaseClient === 'undefined') return;
    supabaseClient.auth.getSession().then(function (res) {
      var user = res && res.data && res.data.session && res.data.session.user;
      if (!user) return;
      var key = 'arko_active_stamp:' + user.id;
      var last = 0;
      try { last = parseInt(localStorage.getItem(key) || '0', 10) || 0; } catch (e) {}
      var serverLast = Date.parse((user.user_metadata && user.user_metadata.last_active_at) || '') || 0;
      if (Date.now() - Math.max(last, serverLast) < EVERY_MS) return;
      try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
      return supabaseClient.auth.updateUser({ data: { last_active_at: new Date().toISOString() } });
    }).catch(function () {});
  }
  // After the page's own startup work, so it never competes with it.
  if (document.readyState === 'complete') setTimeout(stamp, 2000);
  else window.addEventListener('load', function () { setTimeout(stamp, 2000); });
})();
