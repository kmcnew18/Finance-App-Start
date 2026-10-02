// ============= SETTINGS MENU ICONS =============
// Gives every item in a page's Settings dropdown a small line icon, in
// the same style as the Ambient lighting switch's sun. Keyed by the
// button's id, so the menu markup on each page stays plain text and
// one map here keeps every page's icons consistent — a page that adds
// a new menu item just needs an entry below. Items without one simply
// render as before.

(function () {
  // 24x24 stroke paths (stroke-width 2, round caps/joins).
  var P = {
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"></path><path d="M9 12l2 2 4-4"></path>',
    card: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path><path d="M7 15h3"></path>',
    scale: '<path d="M12 4v16"></path><path d="M7 20h10"></path><path d="M5 7h14"></path><path d="M5 7l-3 6a3 3 0 0 0 6 0L5 7z"></path><path d="M19 7l-3 6a3 3 0 0 0 6 0l-3-6z"></path>',
    help: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"></path><path d="M12 17.5h.01"></path>',
    bell: '<path d="M6 10a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"></path><path d="M10 20a2 2 0 0 0 4 0"></path>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"></path><path d="M10 13h4"></path>',
    search: '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path>',
    undo: '<path d="M4 9h11a5 5 0 0 1 0 10H8"></path><path d="M8 5L4 9l4 4"></path>',
    refresh: '<path d="M20 4v6h-6"></path><path d="M4 20v-6h6"></path><path d="M5.6 9a7 7 0 0 1 12-2.4L20 10"></path><path d="M18.4 15a7 7 0 0 1-12 2.4L4 14"></path>',
    repeat: '<path d="M17 2l3 3-3 3"></path><path d="M4 11V9a4 4 0 0 1 4-4h12"></path><path d="M7 22l-3-3 3-3"></path><path d="M20 13v2a4 4 0 0 1-4 4H4"></path>',
    pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"></path>',
    tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z"></path><circle cx="8" cy="8" r="1.5"></circle>',
    trash: '<path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path><path d="M9 7V4h6v3"></path>',
    unlink: '<path d="M9 17H7a5 5 0 0 1 0-10h2"></path><path d="M15 7h2a5 5 0 0 1 4 8"></path><path d="M8 12h3"></path><path d="M3 3l18 18"></path>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"></path><path d="M13.5 6.5l4 4"></path>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l3 3"></path>',
    compass: '<circle cx="12" cy="12" r="9"></circle><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"></path>',
  };

  var BY_ID = {
    'manage-mfa-btn': 'shield',
    'manage-sub-btn': 'card',
    'legal-policies-btn': 'scale',
    'help-faq-btn': 'help',
    'tour-open-btn': 'compass',
    'low-balance-btn': 'bell',
    'view-skipped-btn': 'archive',
    'find-missing-logs-btn': 'search',
    'reset-categories-btn': 'undo',
    'refresh-transactions-btn': 'refresh',
    'refresh-subscriptions-btn': 'repeat',
    'view-activity-btn': 'pulse',
    'manage-categories-btn': 'tag',
    'clear-log-btn': 'trash',
    'clear-transactions-btn': 'trash',
    'clear-subscriptions-btn': 'trash',
    'clear-archives-btn': 'trash',
    'remove-all-btn': 'unlink',
    'override-toggle-row': 'pencil',
  };

  function svg(name) {
    return '<svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + '</svg>';
  }

  function decorate() {
    var dropdown = document.getElementById('settings-dropdown');
    if (!dropdown) return;
    Object.keys(BY_ID).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || !dropdown.contains(el) || el.querySelector('.menu-icon')) return;
      if (el.classList.contains('dropdown-toggle-row')) {
        // Toggle rows: the icon goes with the label text, not the switch.
        var label = el.querySelector('span');
        if (!label) return;
        label.classList.add('menu-icon-label');
        label.insertAdjacentHTML('afterbegin', svg(BY_ID[id]));
      } else {
        el.classList.add('has-menu-icon');
        el.insertAdjacentHTML('afterbegin', svg(BY_ID[id]));
      }
    });
  }

  // Some items briefly swap their text while working ("Refreshing…" →
  // "Up to date" → original), and textContent assignments drop child
  // elements — re-decorate whenever the menu's contents change.
  // decorate() skips anything already carrying an icon, so its own
  // insertions settle immediately instead of looping.
  function init() {
    decorate();
    var dropdown = document.getElementById('settings-dropdown');
    if (dropdown) new MutationObserver(decorate).observe(dropdown, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
