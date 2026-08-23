// transitions.js
//
// Site-wide page-transition system. See transitions.css for the
// .arko-page-exit / .arko-page-enter animation classes this drives.
//
// There's no client-side router anywhere in this app — every
// navigation is a real full-page load. This doesn't change that; it
// just gives that load a deliberate exit beat before it fires, and an
// entrance beat once the destination page reveals its content, so
// moving between pages reads as one continuous motion instead of a
// hard cut.
//
// window.ArkoTransitions.go(url) is the one function any
// *user-initiated* navigation should call instead of assigning
// window.location.href directly — the real <a> click-interceptor
// below just calls this same function, so both paths animate
// identically. Auth-guard / paywall-gate redirects that fire before
// any content is ever shown should NOT be routed through this —
// there's nothing visible to animate, and a security redirect
// shouldn't be made to wait on an animation frame.
(function () {
  var EXIT_MS = 200;
  var SAFETY_MARGIN_MS = 80;
  var REVEAL_GIVE_UP_MS = 5000;

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function exitTarget() {
    return document.querySelector('main') || document.querySelector('.auth-content') || document.body;
  }

  // Covers both display:none (every authenticated page's <main> reveal
  // gate) and visibility:hidden (index.html's body.auth-checking gate) —
  // the two hide/reveal mechanisms actually used across this app.
  function isHidden(el) {
    var cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function go(url) {
    if (!url) return;
    if (reduceMotion) {
      window.location.href = url;
      return;
    }
    var el = exitTarget();
    if (!el) {
      window.location.href = url;
      return;
    }
    var navigated = false;
    var navigate = function () {
      if (navigated) return;
      navigated = true;
      window.location.href = url;
    };
    el.classList.add('arko-page-exit');
    setTimeout(navigate, EXIT_MS + SAFETY_MARGIN_MS);
  }

  function playEntrance(el) {
    if (reduceMotion) return;
    el.classList.add('arko-page-enter');
    el.addEventListener('animationend', function handler() {
      el.classList.remove('arko-page-enter');
      el.removeEventListener('animationend', handler);
    });
  }

  // Every authenticated page's <main> starts hidden until an async
  // auth/data-load check reveals it — well after DOMContentLoaded — so
  // this watches for that reveal instead of keying off page-load
  // timing. Pages with no such gate (log.html, login.html, signup.html)
  // are already visible on the first check and animate immediately.
  function watchForReveal() {
    if (reduceMotion) return;
    var el = exitTarget();
    if (!el) return;

    if (!isHidden(el)) {
      requestAnimationFrame(function () { playEntrance(el); });
      return;
    }

    var settled = false;
    var observer = new MutationObserver(function () {
      if (settled) return;
      if (!isHidden(el)) {
        settled = true;
        observer.disconnect();
        requestAnimationFrame(function () { playEntrance(el); });
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });

    // If content never reveals (e.g. an auth-guard redirected away
    // instead), give up quietly rather than leaking an observer.
    setTimeout(function () {
      if (!settled) { settled = true; observer.disconnect(); }
    }, REVEAL_GIVE_UP_MS);
  }

  function isPlainLeftClick(e) {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  }

  document.addEventListener('click', function (e) {
    if (reduceMotion) return;
    if (!isPlainLeftClick(e)) return;

    var link = e.target.closest('a[href]');
    if (!link) return;
    if (link.target === '_blank') return;
    if (link.hasAttribute('download')) return;
    if (link.protocol !== 'http:' && link.protocol !== 'https:') return;

    var dest;
    try { dest = new URL(link.href, window.location.href); } catch (err) { return; }
    if (dest.origin !== window.location.origin) return;
    // Same-page hash link — let the browser handle the in-page scroll.
    // A cross-page link that happens to carry a hash (e.g. an FAQ deep
    // link into index.html#faq) still animates normally.
    if (dest.pathname === window.location.pathname && dest.hash) return;

    e.preventDefault();
    go(link.href);
  }, true);

  window.ArkoTransitions = { go: go };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchForReveal);
  } else {
    watchForReveal();
  }
})();
