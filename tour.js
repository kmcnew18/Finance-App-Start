/* ============= GUIDED TOUR =============
   A short walkthrough of Arko for new accounts: connecting banks with
   Plaid, giving each account a category, then one step per section.
   Each step pairs a looping animated scene (an SVG mock of that screen,
   played like a tiny video) with a few lines of explanation.

   - Opens once, automatically, on the Dashboard of accounts created
     after this shipped (TOUR_LAUNCH), and never again once closed —
     remembered in user_metadata.tour_seen (plus a per-account
     localStorage flag, so it doesn't flash open before that loads).
   - Re-openable from Settings → "Take the tour" on every app page; it
     starts at the step for the page you're on.
   - ?tour=1 on any app page opens it directly.

   Scenes are plain SVG strings; a small timeline engine (play()) drives
   them from data- attributes — see the SCENES section and tour.css. */
(function () {
  var TOUR_LAUNCH = Date.parse('2026-10-02T00:00:00Z');
  var SEEN_KEY = 'arko_tour_seen';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var PAGE = (location.pathname.match(/(dashboard|connections|budget|log|spending|investments|savings)/) || [])[1] || null;

  var C = {
    bg: '#0F151C', panel: '#141B23', panel2: '#18212B', line: '#26313E', tan: '#E8E1D3', dim: '#7C8489',
    silver: '#B3B6B9', neon: '#4FC3E8', sage: '#6EC496', coral: '#E0806A', gold: '#D8BC7A', violet: '#A88FD8',
    teal: '#6EC4B8', brass: '#E0B96E', blue: '#6E8FA3', red: '#E08B7D', green: '#63D9AA', dark: '#0B1117',
  };

  // ---------- tiny SVG builders ----------
  function attrs(o) {
    var s = '';
    for (var k in o) if (o[k] !== undefined && o[k] !== null && o[k] !== false) s += ' ' + k + '="' + o[k] + '"';
    return s;
  }
  function rect(x, y, w, h, rx, fill, stroke, extra) {
    return '<rect' + attrs({ x: x, y: y, width: w, height: h, rx: rx, fill: fill || 'none', stroke: stroke || 'none' }) + (extra ? ' ' + extra : '') + '/>';
  }
  function text(x, y, str, o) {
    o = o || {};
    var cls = [o.serif && 'ts-serif', o.mono && 'ts-mono', o.italic && 'ts-italic', o.caps && 'ts-caps'].filter(Boolean).join(' ');
    return '<text' + attrs({
      x: x, y: y, 'font-size': o.size || 10, fill: o.fill || C.tan, 'text-anchor': o.anchor,
      'font-weight': o.weight, class: cls || null,
    }) + (o.extra ? ' ' + o.extra : '') + '>' + str + '</text>';
  }
  function g(a, inner) { return '<g' + (a ? ' ' + a : '') + '>' + inner + '</g>'; }
  // Timeline attributes: appear at `t` seconds (with an optional entrance
  // effect), disappear at `off`.
  function at(t, fx, off) {
    return attrs({ 'data-at': t, 'data-fx': fx || null, 'data-off': off === undefined ? null : off });
  }
  function frame() { return rect(10, 10, 440, 220, 14, C.bg, C.line); }
  function cursor(moves, taps) {
    return g('class="ts-cursor"' + attrs({ 'data-move': moves, 'data-tap': taps }),
      g('class="ts-cursor-inner"',
        '<circle class="ts-ripple" r="3" fill="none" stroke="' + C.tan + '" stroke-width="1.5"/>' +
        '<path d="M0 0 L0 16 L4.2 12.2 L7.4 19 L10 17.8 L6.9 11.2 L12.4 11.2 Z" fill="' + C.tan + '" stroke="#0D1117" stroke-width="1.2" stroke-linejoin="round"/>'));
  }
  function svg(dur, label, inner, accent) {
    return '<svg class="ts" viewBox="0 0 460 240" role="img" aria-label="' + label + '" data-dur="' + dur + '">' +
      '<defs><filter id="tsGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<radialGradient id="tsHalo"><stop offset="0%" stop-color="' + (accent || C.neon) + '" stop-opacity="0.22"/><stop offset="100%" stop-color="' + (accent || C.neon) + '" stop-opacity="0"/></radialGradient></defs>' +
      inner + '</svg>';
  }
  function checkMark(cx, cy, color) {
    return '<circle' + attrs({ cx: cx, cy: cy, r: 6.5, fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-opacity': 0.6 }) + '/>' +
      '<path d="M' + (cx - 3) + ' ' + cy + ' l2.2 2.3 l4 -4.4" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  // ---------- SCENES ----------
  var SCENES = {
    welcome: function () {
      var accents = [C.blue, C.green, C.brass, C.coral, C.violet, C.teal];
      var dots = accents.map(function (col, i) {
        var ang = (i * 60 - 90) * Math.PI / 180;
        var x = (230 + 88 * Math.cos(ang)).toFixed(1), y = (120 + 88 * Math.sin(ang)).toFixed(1);
        return g(at(0.35 + i * 0.16, 'pop'),
          '<circle' + attrs({ cx: x, cy: y, r: 7.5, fill: col, filter: 'url(#tsGlow)' }) + '/>' +
          '<circle' + attrs({ cx: x, cy: y, r: 2.6, fill: '#0D1117', 'fill-opacity': 0.4 }) + '/>');
      }).join('');
      var sparkles = [[70, 50], [392, 62], [104, 192], [370, 186], [300, 30], [150, 30]].map(function (p, i) {
        return '<circle class="ts-twinkle"' + attrs({ cx: p[0], cy: p[1], r: 1.6, fill: C.neon, style: 'animation-delay:' + (i * 0.45) + 's' }) + '/>';
      }).join('');
      return svg(8, 'Arko at a glance',
        '<circle cx="230" cy="120" r="118" fill="url(#tsHalo)"/>' + sparkles +
        '<circle class="ts-breathe" cx="230" cy="120" r="52" fill="none" stroke="' + C.neon + '" stroke-opacity="0.35"/>' +
        '<circle cx="230" cy="120" r="88" fill="none" stroke="' + C.neon + '" stroke-opacity="0.16" stroke-dasharray="2 7"/>' +
        g('class="ts-orbit"', dots) +
        g(at(0, 'pop'), '<image href="favicon-192.png" x="200" y="90" width="60" height="60"/>'));
    },

    connect: function (acc) {
      var rows = [
        ['Everyday Checking', 'Checking', '$2,481.20', C.tan],
        ['High-Yield Savings', 'Savings', '$8,930.00', C.tan],
        ['Rewards Card', 'Credit card', '−$412.55', C.red],
      ].map(function (r, i) {
        var y = 74 + i * 46;
        return g(at(4.0 + i * 0.35, 'left'),
          rect(30, y, 400, 38, 9, C.panel, C.line) +
          '<circle' + attrs({ cx: 52, cy: y + 19, r: 10, fill: acc, 'fill-opacity': 0.13, stroke: acc, 'stroke-opacity': 0.5 }) + '/>' +
          '<path d="M47 ' + (y + 21) + 'h10M48 ' + (y + 19) + 'v-3M52 ' + (y + 19) + 'v-3M56 ' + (y + 19) + 'v-3M46.5 ' + (y + 16) + 'l5.5-3.5 5.5 3.5" fill="none" stroke="' + acc + '" stroke-width="1.2" stroke-linecap="round"/>' +
          text(72, y + 17, r[0], { size: 11, weight: 600 }) +
          text(72, y + 30, r[1], { size: 8.5, fill: C.dim }) +
          text(392, y + 23, r[2], { size: 11.5, mono: true, anchor: 'end', fill: r[3] }) +
          g(at(4.3 + i * 0.35, 'pop'), checkMark(414, y + 19, C.sage)));
      }).join('');
      var modal =
        g(at(1.25, null, 3.75), rect(10, 10, 440, 220, 14, '#04070A', 'none', 'fill-opacity="0.62"')) +
        g(at(1.3, 'pop', 3.75),
          rect(110, 56, 240, 140, 12, '#161E27', acc, 'stroke-opacity="0.45"') +
          text(230, 84, 'Connect an account', { size: 13, serif: true, anchor: 'middle' }) +
          text(230, 99, 'Link instantly with Plaid, or add one by hand', { size: 8.5, anchor: 'middle', fill: C.dim }) +
          g('data-tap="2.6"', rect(140, 112, 180, 32, 9, '#2E5472', C.neon, 'stroke-opacity="0.55"') +
            text(230, 132, 'Connect with Plaid', { size: 11, anchor: 'middle', weight: 700 })) +
          g('data-off="2.85"', text(230, 168, 'or add manually', { size: 8.5, anchor: 'middle', fill: C.dim })) +
          g(at(2.85),
            text(230, 166, 'Secure sign-in with your bank…', { size: 8.5, anchor: 'middle', fill: C.neon }) +
            rect(160, 176, 140, 3, 1.5, '#1B2330') +
            rect(160, 176, 140, 3, 1.5, C.neon, null, 'data-at="2.9" data-scale="1"')));
      return svg(9, 'Connecting a bank with Plaid',
        frame() +
        text(30, 40, 'Connections', { size: 15, serif: true }) +
        text(30, 56, 'All your money, one place', { size: 9.5, fill: C.dim }) +
        g('data-tap="0.95"', rect(318, 24, 114, 28, 14, acc) + text(375, 42, '+ Connect account', { size: 10.5, anchor: 'middle', fill: C.dark, weight: 700 })) +
        rows + modal +
        cursor('250,232@0;375,40@0.2;232,130@1.75;330,236@3.3', '0.95;2.6'));
    },

    categorize: function (acc) {
      function chip(x, y, w, label) {
        return rect(x, y, w, 26, 13, C.panel2, C.line) + text(x + w / 2, y + 17, label, { size: 9.5, anchor: 'middle', fill: C.silver });
      }
      function mini(x, y, label, valueHtml, color, t) {
        return g(at(t, 'left'),
          rect(x, y, 170, 40, 10, C.panel, C.line) + rect(x, y + 8, 3, 24, 1.5, color) +
          text(x + 14, y + 16, label, { size: 8.5, fill: C.dim }) + valueHtml);
      }
      return svg(9.5, 'Assigning an account to a Dashboard category',
        frame() +
        text(30, 38, 'Connections', { size: 13, serif: true }) +
        g(at(0, 'up'),
          rect(30, 54, 196, 116, 12, C.panel, C.line) +
          text(46, 79, 'High-Yield Savings', { size: 11.5, weight: 600 }) +
          text(46, 94, 'Savings · via Plaid', { size: 8.5, fill: C.dim }) +
          text(46, 122, '$8,930.00', { size: 16, mono: true }) +
          g('data-off="2.55"', rect(46, 136, 124, 22, 11, 'none', C.dim, 'stroke-dasharray="4 3"') + text(108, 151, 'Tap to categorize', { size: 9.5, anchor: 'middle', fill: C.silver })) +
          g(at(2.55, 'pop'), rect(46, 136, 94, 22, 11, C.sage, C.sage, 'fill-opacity="0.14" stroke-opacity="0.55"') + text(93, 151, 'Savings ✓', { size: 10, anchor: 'middle', fill: C.sage, weight: 700 }))) +
        g(at(1.0, 'pop', 2.5),
          rect(240, 46, 196, 136, 12, '#161E27', acc, 'stroke-opacity="0.45"') +
          text(254, 68, 'Count this account toward…', { size: 9.5, fill: C.dim }) +
          chip(254, 80, 84, 'Checking') + chip(344, 80, 80, 'Savings') +
          g(at(2.05), rect(344, 80, 80, 26, 13, C.sage, C.sage, 'fill-opacity="0.22"') + text(384, 97, 'Savings', { size: 9.5, anchor: 'middle', fill: C.sage, weight: 700 })) +
          chip(254, 112, 84, 'Investment') + chip(344, 112, 80, 'Expenses') +
          text(254, 162, 'Or split it across several by %  →', { size: 9, fill: acc })) +
        g(at(2.9), text(262, 44, 'DASHBOARD', { size: 7.5, fill: C.dim, caps: true })) +
        mini(262, 54, 'Checking', text(276, 82, '$2,481.20', { size: 12, mono: true }), C.gold, 2.9) +
        mini(262, 102, 'Savings', text(276, 130, '$0.00', { size: 12, mono: true, extra: 'data-count="0>8930" data-count-at="4.3" data-fmt="money"' }), C.sage, 3.05) +
        mini(262, 150, 'Investment', text(276, 178, '$0.00', { size: 12, mono: true }), C.violet, 3.2) +
        g(at(4.3, null, 7), rect(262, 102, 170, 40, 10, 'none', C.sage, 'stroke-width="1.5" filter="url(#tsGlow)"')) +
        '<path d="M140 147 C 190 147, 214 122, 262 122" fill="none" stroke="' + C.sage + '" stroke-width="2" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100" filter="url(#tsGlow)" data-at="3.5" data-dash="100 0"/>' +
        cursor('240,236@0;108,148@0.1;384,93@1.35;440,236@2.75', '0.85;2.05'));
    },

    dashboard: function (acc) {
      var cards = [['SAVINGS', '$8,930.00', C.sage], ['INVESTMENT', '$12,400.00', C.violet], ['EXPENSES', null, C.coral], ['CHECKING', '$2,481.20', C.gold]]
        .map(function (c, i) {
          var x = 22 + i * 106;
          var value = c[1]
            ? text(x + 12, 62, c[1], { size: 12, mono: true })
            : text(x + 12, 62, '$1,240.00', { size: 12, mono: true, extra: 'data-count="1240>1244.75" data-count-at="2.9" data-fmt="money"' });
          return g(at(0.1 + i * 0.1, 'up'),
            rect(x, 18, 98, 58, 10, C.panel, C.line) + rect(x + 12, 18, 34, 2, 1, c[2]) +
            text(x + 12, 40, c[0], { size: 7.5, fill: C.dim, caps: true }) + value);
        }).join('');
      function item(y, name, meta, amt, color, t, off, tapAt) {
        return g(at(t, 'left', off),
          rect(34, y, 392, 38, 9, C.panel2, C.line) +
          text(48, y + 17, name, { size: 11, weight: 600 }) +
          text(48, y + 30, meta, { size: 8.5, fill: C.dim }) +
          text(296, y + 23, amt, { size: 11, mono: true, anchor: 'end', fill: color }) +
          rect(306, y + 9, 48, 20, 10, 'none', C.dim, 'stroke-opacity="0.6"') + text(330, y + 23, 'Skip', { size: 8.5, anchor: 'middle', fill: C.silver }) +
          g(tapAt ? 'data-tap="' + tapAt + '"' : '', rect(360, y + 9, 58, 20, 10, acc) + text(389, y + 23, 'Confirm', { size: 8.5, anchor: 'middle', fill: C.dark, weight: 700 })));
      }
      return svg(9.5, 'Confirming detected activity on the Dashboard',
        cards +
        g(at(2.9, null, 4.6), rect(234, 18, 98, 58, 10, 'none', C.coral, 'stroke-width="1.5" filter="url(#tsGlow)"')) +
        g(at(0.4), rect(22, 88, 416, 142, 12, C.panel, C.line) +
          text(36, 110, 'Detected activity', { size: 12.5, serif: true }) +
          text(36, 124, 'Picked up from your connected accounts', { size: 8.5, fill: C.dim })) +
        item(136, 'Corner Coffee', 'Today · Rewards Card', '−$4.75', C.red, 0.9, 3.1, 2.35) +
        g(at(2.6, 'pop', 3.1),
          rect(304, 143, 118, 24, 12, C.panel2) +
          rect(304, 143, 118, 24, 12, C.sage, C.sage, 'fill-opacity="0.18" stroke-opacity="0.55"') +
          text(363, 159, 'Logged ✓', { size: 9.5, anchor: 'middle', fill: C.sage, weight: 700 })) +
        item(136, 'Paycheck', 'Today · Everyday Checking', '+$1,850.00', C.sage, 3.6) +
        item(182, 'Streaming Plus', 'Monthly · Rewards Card', '−$15.99', C.red, 4.0) +
        cursor('250,238@0;389,154@1.5;445,238@2.9', '2.35'));
    },

    log: function (acc) {
      var pills = [['All', 178, 34], ['Add', 216, 38], ['Subtract', 258, 58], ['Transfer', 320, 58]];
      var pillHtml = pills.map(function (p) { return rect(p[1], 48, p[2], 24, 12, 'none', C.line); }).join('') +
        g('data-off="1.75"', rect(178, 48, 34, 24, 12, acc, acc, 'fill-opacity="0.2"')) +
        g(at(1.75, 'pop'), rect(258, 48, 58, 24, 12, acc, acc, 'fill-opacity="0.2"')) +
        pills.map(function (p) { return text(p[1] + p[2] / 2, 64, p[0], { size: 9, anchor: 'middle', fill: C.silver }); }).join('');
      var rows = [
        ['Oct 1', '$1,200.00', 'Bills', 'Rent', C.red],
        ['Sep 30', '$4.75', 'Expenses', 'Corner Coffee', C.red],
        ['Sep 28', '$250.00', 'Savings', 'Moved to savings', C.gold],
        ['Sep 27', '$1,850.00', 'Checking', 'Paycheck', C.sage],
      ].map(function (r, i) {
        var y = 108 + i * 29;
        var note = i === 1
          ? g('data-off="3.7"', text(290, y + 18, r[3], { size: 10, serif: true, italic: true, fill: C.silver })) +
            g(at(3.6), rect(284, y + 4, 142, 21, 5, '#0D1218', acc)) +
            text(290, y + 18, '', { size: 10, serif: true, italic: true, extra: 'data-at="3.7" data-type="Coffee + bagel"' })
          : text(290, y + 18, r[3], { size: 10, serif: true, italic: true, fill: C.silver });
        return g(at(0.2 + i * 0.15, 'left', i >= 2 ? 2.0 : undefined),
          rect(30, y + 5, 3, 19, 1.5, r[4]) +
          text(44, y + 18, r[0], { size: 9.5, fill: C.silver }) +
          text(110, y + 18, r[1], { size: 10, mono: true }) +
          text(200, y + 18, r[2], { size: 9.5 }) + note +
          '<line x1="30" x2="434" y1="' + (y + 28.5) + '" y2="' + (y + 28.5) + '" stroke="' + C.line + '" stroke-width="0.6"/>');
      }).join('');
      return svg(9, 'Filtering and editing the Log',
        text(30, 36, 'Full Log', { size: 14, serif: true }) +
        rect(30, 48, 138, 24, 12, '#0D1218', C.line) +
        '<circle cx="45" cy="59.5" r="4.5" fill="none" stroke="' + C.dim + '" stroke-width="1.3"/><path d="M48.3 62.8l3 3" stroke="' + C.dim + '" stroke-width="1.3" stroke-linecap="round"/>' +
        text(58, 64, 'Search notes…', { size: 9, fill: C.dim }) +
        pillHtml +
        g('data-tap="5.6"', rect(386, 48, 48, 24, 8, 'none', acc, 'stroke-opacity="0.6"') + text(410, 64, 'CSV ↓', { size: 9, anchor: 'middle', fill: acc, weight: 700 })) +
        rect(30, 84, 404, 146, 10, C.panel, C.line) +
        text(44, 100, 'DATE', { size: 7.5, fill: C.dim, caps: true }) + text(110, 100, 'AMOUNT', { size: 7.5, fill: C.dim, caps: true }) +
        text(200, 100, 'CATEGORY', { size: 7.5, fill: C.dim, caps: true }) + text(290, 100, 'NOTES', { size: 7.5, fill: C.dim, caps: true }) +
        rows +
        g(at(5.85, 'up', 7.6), rect(150, 196, 160, 24, 12, '#1B2330', C.sage, 'stroke-opacity="0.5"') + text(230, 212, 'Exported log.csv', { size: 9.5, anchor: 'middle', fill: C.sage, weight: 600 })) +
        cursor('250,238@0;287,60@0.95;350,150@2.65;410,60@4.8;445,238@6.4', '1.75;3.5;5.6'));
    },

    budget: function (acc) {
      var rail = ['Income', 'Bills', 'Expenses', 'Savings', 'Debt'].map(function (label, i) {
        var on = i === 0;
        return g(at(i * 0.08, 'left'),
          rect(22, 24 + i * 40, 74, 32, 9, on ? acc : C.panel, on ? acc : C.line, on ? 'fill-opacity="0.14" stroke-opacity="0.6"' : '') +
          text(59, 44 + i * 40, label, { size: 9.5, anchor: 'middle', fill: on ? acc : C.silver, weight: on ? 700 : null }));
      }).join('');
      var rows = [['Income', C.sage, '$3,200', 1], ['Bills', C.coral, '$1,450', 0.86], ['Expenses', acc, '$800', 0.72], ['Savings', C.teal, '$400', 0.5]]
        .map(function (r, i) {
          var y = 72 + i * 34;
          return text(112, y + 10, r[0], { size: 10 }) + text(434, y + 10, 'of ' + r[2], { size: 8.5, fill: C.dim, anchor: 'end', mono: true }) +
            rect(112, y + 16, 322, 7, 3.5, '#1B2330') +
            rect(112, y + 16, 322, 7, 3.5, r[1], null, 'data-at="' + (0.6 + i * 0.2) + '" data-scale="' + r[3] + '"');
        }).join('');
      return svg(9.5, 'Planning a budget period',
        frame() + rail +
        text(112, 34, 'BUDGET PLANNER', { size: 7.5, fill: acc, caps: true, weight: 700 }) +
        text(112, 54, 'Oct 1 – Oct 31', { size: 14, serif: true }) +
        g('data-tap="4.6"', rect(352, 26, 82, 24, 12, 'none', acc, 'stroke-opacity="0.6"') + text(393, 42, '+ From log', { size: 9, anchor: 'middle', fill: acc, weight: 700 })) +
        rows +
        g(at(4.9, 'up', 6.6), rect(326, 138, 56, 16, 8, acc, acc, 'fill-opacity="0.16" stroke-opacity="0.5"') + text(354, 149.5, '+$4.75', { size: 8.5, anchor: 'middle', fill: acc, weight: 700 })) +
        '<line x1="112" x2="434" y1="206" y2="206" stroke="' + C.line + '"/>' +
        text(112, 222, 'Left over this period', { size: 9.5, fill: C.dim }) +
        text(434, 224, '$0.00', { size: 14, mono: true, anchor: 'end', fill: acc, extra: 'data-count="0>640" data-count-at="2.2" data-fmt="money"' }) +
        cursor('250,238@0;393,38@3.8;445,238@5.3', '4.6'));
    },

    spending: function (acc) {
      var cats = [['Housing', '#C97C7C', 30, '$552.63'], ['Groceries', '#C9AA7C', 24, '$442.10'], ['Dining Out', '#7CC99B', 16, '$294.74'],
        ['Shopping', '#7CC9C9', 14, '$257.89'], ['Transportation', '#B5AB53', 10, '$184.21'], ['Entertainment', '#53B598', 6, '$110.53']];
      var start = 0;
      var segs = cats.map(function (c, i) {
        var s = '<circle' + attrs({
          cx: 120, cy: 134, r: 62, fill: 'none', stroke: c[1], 'stroke-width': 20, pathLength: 100,
          'stroke-dasharray': '0 100', 'stroke-dashoffset': -start, transform: 'rotate(-90 120 134)',
          'data-at': (0.3 + i * 0.18).toFixed(2), 'data-dash': (c[2] - 0.8) + ' ' + (100 - c[2] + 0.8),
        }) + '/>';
        start += c[2];
        return s;
      }).join('');
      var legend = cats.map(function (c, i) {
        var y = 62 + i * 25;
        return g(at(0.8 + i * 0.12, 'left'),
          '<circle cx="222" cy="' + y + '" r="4.5" fill="' + c[1] + '"/>' +
          text(234, y + 3.5, c[0], { size: 10 }) + text(434, y + 3.5, c[3], { size: 9.5, mono: true, anchor: 'end', fill: C.silver }));
      }).join('');
      var chevron = function (cx, dir) {
        return '<circle cx="' + cx + '" cy="28" r="11" fill="none" stroke="' + C.line + '"/>' +
          '<path d="M' + (cx + 2 * dir) + ' 23.5 l' + (-4.5 * dir) + ' 4.5 l' + (4.5 * dir) + ' 4.5" fill="none" stroke="' + C.silver + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
      };
      return svg(8.5, 'Spending by category for a month',
        g('data-tap="5.0"', chevron(150, 1)) + chevron(310, -1) +
        g('data-off="5.2"', text(230, 32, 'October 2026', { size: 13, serif: true, anchor: 'middle' })) +
        g(at(5.2, 'up'), text(230, 32, 'September 2026', { size: 13, serif: true, anchor: 'middle' })) +
        '<circle cx="120" cy="134" r="62" fill="none" stroke="#1B2330" stroke-width="20"/>' + segs +
        g('data-off="5.2"', text(120, 133, '$0.00', { size: 14, mono: true, anchor: 'middle', extra: 'data-count="0>1842.10" data-count-at="0.4" data-fmt="money"' })) +
        g(at(5.2, 'up'), text(120, 133, '$1,615.40', { size: 14, mono: true, anchor: 'middle' })) +
        text(120, 149, 'spent', { size: 9, anchor: 'middle', fill: C.dim }) +
        legend +
        g(at(2.6, 'up'), rect(214, 206, 220, 24, 12, acc, acc, 'fill-opacity="0.12" stroke-opacity="0.45"') +
          text(324, 222, '4 subscriptions found · $58.96/mo', { size: 8.5, anchor: 'middle', fill: acc, weight: 600 })) +
        cursor('250,238@0;150,30@4.25;445,238@5.7', '5.0'));
    },

    investments: function (acc) {
      var holdings = [['VTI', 'Total Market ETF', '$6,120.00', 49, '#A88FD8'], ['AAPL', 'Apple', '$2,310.00', 19, '#C3B1EC'],
        ['BND', 'Bond Index', '$1,940.00', 16, '#8C7CC9'], ['VXUS', 'Intl. Stock ETF', '$1,450.00', 11, '#D8C9F5']];
      var start = 0;
      var ringParts = holdings.concat([['', '', '', 5, '#6E5CA8']]).map(function (h, i) {
        var s = '<circle' + attrs({
          cx: 124, cy: 138, r: 62, fill: 'none', stroke: h[4], 'stroke-width': 14, 'stroke-linecap': 'butt', pathLength: 100,
          'stroke-dasharray': '0 100', 'stroke-dashoffset': -start, transform: 'rotate(-90 124 138)',
          'data-at': (0.3 + i * 0.16).toFixed(2), 'data-dash': (h[3] - 1.2) + ' ' + (100 - h[3] + 1.2), 'data-off': i === 2 ? 3.1 : null,
        }) + '/>';
        start += h[3];
        return s;
      }).join('');
      var rows = holdings.map(function (h, i) {
        var y = 50 + i * 42;
        var toggle = i === 2
          ? g('data-off="3.0"', rect(404, y + 12, 22, 12, 6, acc)) + g(at(3.0), rect(404, y + 12, 22, 12, 6, '#2A3442')) +
            g('data-move="0,0@0;-10,0@2.95"', '<circle cx="420" cy="' + (y + 18) + '" r="4.5" fill="#0D1117"/>')
          : rect(404, y + 12, 22, 12, 6, acc) + '<circle cx="420" cy="' + (y + 18) + '" r="4.5" fill="#0D1117"/>';
        return g(at(0.6 + i * 0.12, 'left'),
          rect(236, y, 198, 36, 9, C.panel, C.line) +
          text(248, y + 16, h[0], { size: 10.5, weight: 700 }) + text(248, y + 28, h[1], { size: 8, fill: C.dim }) +
          text(396, y + 22, h[2], { size: 9.5, mono: true, anchor: 'end', fill: C.silver }) + toggle);
      }).join('');
      return svg(8.5, 'An investment portfolio ring with holdings',
        rect(34, 20, 180, 26, 13, '#0D1218', C.line) +
        g('data-off="4.6"', rect(37, 23, 54, 20, 10, acc, acc, 'fill-opacity="0.22" stroke-opacity="0.6"')) +
        g(at(4.6, 'pop'), rect(97, 23, 54, 20, 10, acc, acc, 'fill-opacity="0.22" stroke-opacity="0.6"')) +
        text(64, 37, 'All', { size: 9, anchor: 'middle' }) + text(124, 37, 'Taxable', { size: 9, anchor: 'middle' }) + text(184, 37, 'Roth', { size: 9, anchor: 'middle' }) +
        '<circle cx="124" cy="138" r="62" fill="none" stroke="#1B2330" stroke-width="14"/>' + ringParts +
        g('data-off="3.1"', text(124, 134, '$0.00', { size: 14, mono: true, anchor: 'middle', extra: 'data-count="0>12400" data-count-at="0.4" data-fmt="money"' })) +
        g(at(3.1, null, 4.6), text(124, 134, '$10,460.00', { size: 14, mono: true, anchor: 'middle' })) +
        g(at(4.6, 'up'), text(124, 134, '$7,820.00', { size: 14, mono: true, anchor: 'middle' })) +
        g(at(1.6, 'pop'), rect(86, 146, 76, 18, 9, C.sage, C.sage, 'fill-opacity="0.14" stroke-opacity="0.45"') + text(124, 159, '+4.2% · 3M', { size: 8.5, anchor: 'middle', fill: C.sage, weight: 700 })) +
        text(236, 38, 'Holdings', { size: 12, serif: true }) + rows +
        cursor('250,238@0;415,152@1.9;124,33@3.6;445,238@5.3', '2.95;4.5'));
    },

    savings: function (acc) {
      var leaf = function (d, t) { return g(at(t, 'pop'), '<path d="' + d + '" fill="' + C.sage + '" fill-opacity="0.9"/>'); };
      var petals = [0, 72, 144, 216, 288].map(function (r) {
        return '<ellipse cx="116" cy="47" rx="3.4" ry="6.5" fill="' + C.teal + '" transform="rotate(' + r + ' 116 53)"/>';
      }).join('');
      return svg(9.5, 'A savings goal filling up',
        rect(28, 16, 176, 208, 16, '#121A21', acc, 'stroke-opacity="0.45" filter="url(#tsGlow)"') +
        rect(28, 16, 176, 208, 16, '#121A21', acc, 'stroke-opacity="0.45"') +
        '<ellipse cx="116" cy="142" rx="30" ry="5" fill="#000" fill-opacity="0.3"/>' +
        '<path d="M116 112 L116 58" stroke="' + C.sage + '" stroke-width="3.2" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100" class="ts-slow" data-at="0.4" data-dash="100 0"/>' +
        leaf('M116 96 C 100 90, 93 74, 108 64 C 115 76, 118 86, 116 96 Z', 1.2) +
        leaf('M116 82 C 132 76, 139 61, 125 52 C 117 63, 114 73, 116 82 Z', 1.6) +
        g(at(2.3, 'pop'), petals + '<circle cx="116" cy="53" r="3.6" fill="' + C.brass + '"/>') +
        '<path d="M96 118 L136 118 L130 140 L102 140 Z" fill="#2C1F14" stroke="' + acc + '" stroke-width="1.4"/>' +
        rect(93, 111, 46, 9, 3, '#3A2A1A', acc, 'stroke-width="1.4"') +
        text(116, 166, 'Japan Trip', { size: 13, serif: true, anchor: 'middle' }) +
        text(116, 182, '$0 of $5,000', { size: 9.5, mono: true, anchor: 'middle', fill: C.silver, extra: 'data-count="0>3200" data-count-at="0.4" data-fmt="money0" data-suffix=" of $5,000"' }) +
        rect(46, 192, 140, 6, 3, '#1B2330') +
        rect(46, 192, 140, 6, 3, acc, null, 'class="ts-slow" data-at="0.4" data-scale="0.64"') +
        text(116, 213, '0%', { size: 10, anchor: 'middle', fill: acc, weight: 700, extra: 'data-count="0>64" data-count-at="0.4" data-fmt="int" data-suffix="%"' }) +
        text(226, 38, 'Funded by', { size: 9.5, fill: C.dim }) +
        g(at(2.6, 'left'), rect(226, 48, 208, 38, 10, C.panel, C.line) +
          text(240, 64, 'High-Yield Savings', { size: 10, weight: 600 }) + text(240, 78, '30% of balance', { size: 8, fill: C.dim }) +
          text(422, 71, '$2,679.00', { size: 9.5, mono: true, anchor: 'end', fill: C.silver })) +
        g(at(3.0, 'left'), rect(226, 94, 208, 38, 10, C.panel, C.line) +
          text(240, 110, 'Everyday Checking', { size: 10, weight: 600 }) + text(240, 124, 'Fixed amount', { size: 8, fill: C.dim }) +
          text(422, 117, '$521.00', { size: 9.5, mono: true, anchor: 'end', fill: C.silver })) +
        g(at(3.8, 'pop'), rect(226, 148, 208, 30, 15, acc, acc, 'fill-opacity="0.12" stroke-opacity="0.45"') +
          text(330, 167, 'On track · save $85/week', { size: 9.5, anchor: 'middle', fill: acc, weight: 700 })) +
        g(at(4.1), text(226, 202, 'Target date', { size: 8.5, fill: C.dim }) + text(434, 202, 'Mar 14, 2027', { size: 9.5, mono: true, anchor: 'end', fill: C.silver })));
    },

    finish: function (acc) {
      var digits = '481207'.split('').map(function (d, i) {
        var x = 149 + i * 28;
        return rect(x, 136, 22, 28, 6, '#0D1218', C.line) +
          g(at(0.5 + i * 0.22, 'pop'), text(x + 11, 155, d, { size: 13, mono: true, anchor: 'middle' }));
      }).join('');
      var gear = '<g class="ts-spin-slow"><circle cx="408" cy="40" r="7" fill="none" stroke="' + C.silver + '" stroke-width="1.6"/>' +
        [0, 45, 90, 135, 180, 225, 270, 315].map(function (r) {
          return '<line x1="408" y1="29.5" x2="408" y2="33" stroke="' + C.silver + '" stroke-width="2.2" stroke-linecap="round" transform="rotate(' + r + ' 408 40)"/>';
        }).join('') + '</g>';
      var sun = '<g class="ts-breathe"><circle cx="52" cy="40" r="5.5" fill="none" stroke="' + C.neon + '" stroke-width="1.6" filter="url(#tsGlow)"/>' +
        [0, 45, 90, 135, 180, 225, 270, 315].map(function (r) {
          return '<line x1="52" y1="28.5" x2="52" y2="31" stroke="' + C.neon + '" stroke-width="1.6" stroke-linecap="round" transform="rotate(' + r + ' 52 40)"/>';
        }).join('') + '</g>';
      return svg(8, 'Two-factor code with a trusted device',
        '<circle cx="230" cy="96" r="100" fill="url(#tsHalo)"/>' +
        '<path d="M230 36 L262 48 L262 76 C262 98 248 112 230 120 C212 112 198 98 198 76 L198 48 Z" fill="' + acc + '" fill-opacity="0.07" stroke="' + acc + '" stroke-width="2" filter="url(#tsGlow)"/>' +
        '<path d="M215 78 L226 89 L246 66" fill="none" stroke="' + acc + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="100" stroke-dasharray="0 100" data-at="2.9" data-dash="100 0"/>' +
        digits +
        rect(140, 180, 180, 28, 9, '#0D1218', acc, 'stroke-opacity="0.3"') +
        rect(151, 188.5, 11, 11, 3, 'none', acc) +
        '<path d="M153.5 194 L156.2 196.8 L160.5 191.2" fill="none" stroke="' + acc + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" pathLength="100" stroke-dasharray="0 100" data-at="2.2" data-dash="100 0"/>' +
        text(170, 198, 'Trust this device for 30 days', { size: 9.5 }) +
        sun + text(52, 64, 'Ambient', { size: 8, fill: C.dim, anchor: 'middle' }) +
        gear + text(408, 64, 'Settings', { size: 8, fill: C.dim, anchor: 'middle' }));
    },
  };

  // ---------- STEPS ----------
  var ICON = {
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"></path>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"></path><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"></path>',
    tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z"></path><circle cx="8" cy="8" r="1.5"></circle>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3 6h.01M3 12h.01M3 18h.01"></path>',
    ledger: '<path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"></path><path d="M8 9h8M8 13h6"></path>',
    pie: '<path d="M21 12a9 9 0 1 1-9-9"></path><path d="M21 3v9h-9"></path>',
    ring: '<circle cx="12" cy="12" r="8"></circle><path d="M12 4a8 8 0 0 1 8 8"></path><path d="M12 12l4-4"></path>',
    sprout: '<path d="M12 20v-8"></path><path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6z"></path><path d="M12 14c0-3-2-5-6-5 0 3 2 5 6 5z"></path>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"></path><path d="M9 12l2 2 4-4"></path>',
  };

  var STEPS = [
    { key: 'welcome', page: 'dashboard', accent: C.neon, icon: 'sparkle', eyebrow: 'Welcome',
      title: 'Welcome to Arko',
      text: 'Every account, budget, and goal in one calm place. Here’s a two-minute look at how it all fits together.',
      points: ['Connect your banks once — balances and purchases flow in on their own', 'Each section has one job: see it, plan it, or grow it', 'Replay this tour anytime from Settings'] },
    { key: 'connect', page: 'connections', tier: 2, accent: C.green, icon: 'link', eyebrow: 'Connections',
      title: 'Connect your banks',
      text: 'In Connections, tap + Connect account, then Connect with Plaid. Sign in to your bank in Plaid’s secure window and choose which accounts to bring in.',
      points: ['Arko never sees your bank password — Plaid handles sign-in', 'Pick exactly which accounts to add; add the rest anytime', 'Bank not listed? Add the account by hand instead'] },
    { key: 'categorize', page: 'connections', tier: 2, accent: C.green, icon: 'tag', eyebrow: 'Connections',
      title: 'Give each account a category',
      text: 'Each account card has a “Tap to categorize” pill. Choose which Dashboard category it counts toward — Checking, Savings, Investment, Expenses, or one you create.',
      points: ['Split one account across several categories by percent', 'Set aside a fixed amount of it for a category', 'Credit cards pick the category that pays them off'] },
    { key: 'dashboard', page: 'dashboard', accent: C.blue, icon: 'grid', eyebrow: 'Dashboard',
      title: 'Your money at a glance',
      text: 'Your Money shows each category’s total, kept in sync with Connections. New purchases and deposits appear under Detected activity — confirm to log them, or skip.',
      points: ['Drag cards to reorder; ⋯ renames or groups them, the color dot recolors', 'Add, Subtract, and Transfer for anything not connected', 'Side tabs hold your recent activity and quick notes'] },
    { key: 'log', page: 'log', accent: C.blue, icon: 'list', eyebrow: 'Full Log',
      title: 'Every entry, in one ledger',
      text: 'Everything you confirm or enter on the Dashboard lands in the Full Log with its date, amount, and categories — open it with View Log at the top of the Dashboard.',
      points: ['Search notes and filter by month or type', 'Click any note to edit it in place', 'Export to CSV, or select entries to delete'] },
    { key: 'budget', page: 'budget', accent: C.brass, icon: 'ledger', eyebrow: 'Budget Planner',
      title: 'Plan each period',
      text: 'Set a start and end date, then fill in Income, Bills, Expenses, Savings, and Debt. The Cash Flow Summary shows what’s left as real spending comes in.',
      points: ['+ From log pulls confirmed entries into the plan', 'Save as default layout to start the next period pre-filled', 'Finalize to archive it; charts track what’s left over time'] },
    { key: 'spending', page: 'spending', tier: 3, accent: C.coral, icon: 'pie', eyebrow: 'Spendings',
      title: 'See where it went',
      text: 'Spendings sorts every purchase from your connected cards and checking by category, one month at a time.',
      points: ['Fix a category, or map a merchant to a budget line', 'Subscriptions and recurring charges are found for you', 'An older month empty? Retrieve it from your banks'] },
    { key: 'investments', page: 'investments', tier: 3, accent: C.violet, icon: 'ring', eyebrow: 'Investments',
      title: 'Track your portfolio',
      text: 'Holdings from connected brokerages come together in one ring, with your return over any period from a week to all time.',
      points: ['Tag accounts once to switch between Taxable and Roth', 'Leave any holding in or out of the chart', 'Positions under 5% group together to keep it readable'] },
    { key: 'savings', page: 'savings', tier: 3, accent: C.teal, icon: 'sprout', eyebrow: 'Visual Savings',
      title: 'Watch your goals grow',
      text: 'Create a goal, pick its illustration, and link the accounts that fund it — the picture fills in as your balance grows.',
      points: ['Fund a goal with a whole account, a percent, or a fixed amount', 'Add a target date to get a weekly savings pace', 'Six themes: plant, ship, balloon, rocket, lighthouse, kite'] },
    { key: 'finish', page: null, accent: C.neon, icon: 'shield', eyebrow: 'You’re all set',
      title: 'Safe, and yours to shape',
      text: 'Two-factor authentication protects changes to your connections. Check “Trust this device” when you enter a code to skip it here for 30 days.',
      points: ['Settings (⚙) holds two-factor, alerts, and ambient lighting', 'Low-balance alerts warn you before a category runs low', 'Replay this tour anytime from Settings → Take the tour'] },
  ];

  // ---------- timeline engine ----------
  var timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function stopScene() { timers.forEach(clearTimeout); timers = []; }

  function fmt(n, kind, el) {
    var s;
    if (kind === 'money') s = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    else if (kind === 'money0') s = '$' + Math.round(n).toLocaleString('en-US');
    else s = String(Math.round(n));
    return s + (el.getAttribute('data-suffix') || '');
  }
  function countParts(el) {
    var p = el.getAttribute('data-count').split('>');
    return { from: parseFloat(p[0]), to: parseFloat(p[1]), kind: el.getAttribute('data-fmt') };
  }
  function parseMoves(el) {
    return el.getAttribute('data-move').split(';').map(function (part) {
      var bits = part.split('@'), xy = bits[0].split(',');
      return { x: parseFloat(xy[0]), y: parseFloat(xy[1]), t: parseFloat(bits[1]) };
    });
  }

  function resetScene(svgEl) {
    svgEl.querySelectorAll('.on').forEach(function (el) { el.classList.remove('on'); });
    svgEl.querySelectorAll('.gone').forEach(function (el) { el.classList.remove('gone'); });
    svgEl.querySelectorAll('.tap').forEach(function (el) { el.classList.remove('tap'); });
    svgEl.querySelectorAll('[data-dash]').forEach(function (el) { el.style.strokeDasharray = '0 100'; });
    svgEl.querySelectorAll('[data-scale]').forEach(function (el) { el.style.transform = 'scaleX(0)'; });
    svgEl.querySelectorAll('[data-count]').forEach(function (el) { var c = countParts(el); el.textContent = fmt(c.from, c.kind, el); });
    svgEl.querySelectorAll('[data-type]').forEach(function (el) { el.textContent = ''; });
    svgEl.querySelectorAll('[data-move]').forEach(function (el) {
      var first = parseMoves(el)[0];
      el.style.transition = 'none';
      el.style.transform = 'translate(' + first.x + 'px,' + first.y + 'px)';
      el.getBoundingClientRect(); // commit the jump before re-enabling the transition
      el.style.transition = '';
    });
  }

  function turnOn(el) {
    el.classList.add('on');
    if (el.hasAttribute('data-dash')) el.style.strokeDasharray = el.getAttribute('data-dash');
    if (el.hasAttribute('data-scale')) el.style.transform = 'scaleX(' + el.getAttribute('data-scale') + ')';
    if (el.hasAttribute('data-type')) {
      var full = el.getAttribute('data-type'), i = 0;
      (function step() { el.textContent = full.slice(0, ++i); if (i < full.length) later(step, 70); })();
    }
  }
  function runCount(el) {
    var c = countParts(el), t0 = performance.now(), dur = 1100;
    (function tick(now) {
      var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(c.from + (c.to - c.from) * e, c.kind, el);
      if (p < 1 && timers.length) requestAnimationFrame(tick);
    })(t0);
  }

  function finalState(svgEl) {
    svgEl.querySelectorAll('[data-at]').forEach(turnOn);
    svgEl.querySelectorAll('[data-off]').forEach(function (el) { el.classList.add('gone'); });
    svgEl.querySelectorAll('[data-count]').forEach(function (el) { var c = countParts(el); el.textContent = fmt(c.to, c.kind, el); });
    svgEl.querySelectorAll('[data-type]').forEach(function (el) { el.textContent = el.getAttribute('data-type'); });
    svgEl.querySelectorAll('.ts-cursor').forEach(function (el) { el.style.display = 'none'; });
  }

  function play(svgEl) {
    stopScene();
    resetScene(svgEl);
    if (reduceMotion) { finalState(svgEl); return; }
    svgEl.querySelectorAll('[data-at]').forEach(function (el) {
      later(function () { turnOn(el); }, parseFloat(el.getAttribute('data-at')) * 1000);
    });
    svgEl.querySelectorAll('[data-off]').forEach(function (el) {
      later(function () { el.classList.add('gone'); }, parseFloat(el.getAttribute('data-off')) * 1000);
    });
    svgEl.querySelectorAll('[data-tap]').forEach(function (el) {
      el.getAttribute('data-tap').split(';').forEach(function (t) {
        later(function () { el.classList.add('tap'); later(function () { el.classList.remove('tap'); }, 320); }, parseFloat(t) * 1000);
      });
    });
    svgEl.querySelectorAll('[data-move]').forEach(function (el) {
      parseMoves(el).slice(1).forEach(function (m) {
        later(function () { el.style.transform = 'translate(' + m.x + 'px,' + m.y + 'px)'; }, m.t * 1000);
      });
    });
    svgEl.querySelectorAll('[data-count]').forEach(function (el) {
      var t = el.getAttribute('data-count-at') || el.getAttribute('data-at') || '0';
      later(function () { runCount(el); }, parseFloat(t) * 1000);
    });
    // Loop like a short video: hold the last frame, fade, start over.
    var dur = parseFloat(svgEl.getAttribute('data-dur') || '8') * 1000;
    later(function () {
      svgEl.classList.add('ts-fadeout');
      later(function () { svgEl.classList.remove('ts-fadeout'); play(svgEl); }, 420);
    }, dur);
  }

  // ---------- the dialog ----------
  var root = null, card = null, index = 0, lastFocus = null;

  function tierNow() { return typeof userTier !== 'undefined' && typeof userTier === 'number' ? userTier : null; }
  function check() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>'; }
  function iconSvg(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>'; }

  function build() {
    root = document.createElement('div');
    root.className = 'arko-tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'arko-tour-title');
    root.innerHTML =
      '<div class="arko-tour-card">' +
        '<div class="arko-tour-progress">' + STEPS.map(function (s, i) {
          return '<button type="button" class="arko-tour-seg" data-i="' + i + '" aria-label="Go to step ' + (i + 1) + ': ' + s.title + '"></button>';
        }).join('') + '</div>' +
        '<button type="button" class="arko-tour-close" aria-label="Close tour">×</button>' +
        '<div class="arko-tour-stage"></div>' +
        '<div class="arko-tour-body">' +
          '<div class="arko-tour-eyebrow"></div>' +
          '<h2 class="arko-tour-title" id="arko-tour-title"></h2>' +
          '<p class="arko-tour-text"></p>' +
          '<ul class="arko-tour-points"></ul>' +
        '</div>' +
        '<div class="arko-tour-foot">' +
          '<button type="button" class="arko-tour-skip">Skip tour</button>' +
          '<span class="arko-tour-count"></span>' +
          '<div class="arko-tour-nav">' +
            '<button type="button" class="arko-tour-back">Back</button>' +
            '<button type="button" class="arko-tour-next">Next</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    card = root.querySelector('.arko-tour-card');

    root.querySelector('.arko-tour-close').addEventListener('click', close);
    root.querySelector('.arko-tour-skip').addEventListener('click', close);
    root.querySelector('.arko-tour-back').addEventListener('click', function () { go(index - 1); });
    root.querySelector('.arko-tour-next').addEventListener('click', onNext);
    root.querySelectorAll('.arko-tour-seg').forEach(function (b) {
      b.addEventListener('click', function () { go(parseInt(b.dataset.i, 10)); });
    });

    // Swipe between steps on touch screens.
    var stage = root.querySelector('.arko-tour-stage'), sx = null, sy = null;
    stage.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; });
    stage.addEventListener('pointerup', function (e) {
      if (sx === null) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      sx = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) go(index + (dx < 0 ? 1 : -1));
    });

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', function () {
      if (!root || !root.classList.contains('open')) return;
      if (document.hidden) stopScene(); else { var s = root.querySelector('.ts'); if (s) play(s); }
    });
  }

  function onKey(e) {
    if (!root || !root.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); return; }
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      var f = Array.prototype.filter.call(card.querySelectorAll('button'), function (b) { return b.offsetParent !== null && !b.hidden; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function finalCta() {
    var t = tierNow();
    if ((t === null || t >= 2) && PAGE !== 'connections') return { label: 'Connect a bank', href: 'connections.html' };
    return { label: 'Finish', href: null };
  }

  function onNext() {
    if (index < STEPS.length - 1) { go(index + 1); return; }
    var cta = finalCta();
    close();
    if (cta.href) {
      if (window.ArkoTransitions && ArkoTransitions.go) ArkoTransitions.go(cta.href);
      else location.href = cta.href;
    }
  }

  function render(dir) {
    var s = STEPS[index];
    card.style.setProperty('--tour-accent', s.accent);
    var t = tierNow();
    var locked = s.tier && t !== null && t < s.tier;
    root.querySelector('.arko-tour-eyebrow').innerHTML = iconSvg(s.icon) + '<span>' + s.eyebrow + '</span>' +
      (locked ? '<span class="arko-tour-tier">Tier ' + s.tier + (s.tier === 2 ? '+' : '') + '</span>' : '');
    root.querySelector('.arko-tour-title').textContent = s.title;
    root.querySelector('.arko-tour-text').textContent = s.text;
    root.querySelector('.arko-tour-points').innerHTML = s.points.map(function (p) {
      return '<li>' + check() + '<span>' + p.replace(/</g, '&lt;') + '</span></li>';
    }).join('');
    root.querySelector('.arko-tour-count').textContent = (index + 1) + ' / ' + STEPS.length;
    root.querySelectorAll('.arko-tour-seg').forEach(function (b, i) {
      b.classList.toggle('current', i === index);
      b.classList.toggle('done', i < index);
      if (i === index) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    root.querySelector('.arko-tour-back').hidden = index === 0;
    var isLast = index === STEPS.length - 1;
    root.querySelector('.arko-tour-skip').style.visibility = isLast ? 'hidden' : '';
    root.querySelector('.arko-tour-next').textContent = isLast ? finalCta().label : (index === 0 ? 'Start the tour' : 'Next');

    var stage = root.querySelector('.arko-tour-stage');
    stage.innerHTML = SCENES[s.key](s.accent);
    card.classList.remove('swap-next', 'swap-prev');
    if (dir) { card.getBoundingClientRect(); card.classList.add(dir > 0 ? 'swap-next' : 'swap-prev'); }
    play(stage.querySelector('.ts'));
  }

  function go(i) {
    if (i < 0 || i >= STEPS.length || i === index) return;
    var dir = i > index ? 1 : -1;
    index = i;
    render(dir);
  }

  function open(startIndex) {
    if (!root) build();
    index = Math.max(0, Math.min(STEPS.length - 1, startIndex || 0));
    lastFocus = document.activeElement;
    root.style.display = 'flex';
    document.documentElement.style.overflow = 'hidden';
    render(0);
    requestAnimationFrame(function () { root.classList.add('open'); });
    setTimeout(function () { root.querySelector('.arko-tour-next').focus({ preventScroll: true }); }, 60);
  }

  function close() {
    if (!root || !root.classList.contains('open')) return;
    stopScene();
    root.classList.remove('open');
    document.documentElement.style.overflow = '';
    setTimeout(function () { if (!root.classList.contains('open')) { root.style.display = 'none'; root.querySelector('.arko-tour-stage').innerHTML = ''; } }, 360);
    if (lastFocus && lastFocus.focus) try { lastFocus.focus({ preventScroll: true }); } catch (e) {}
    markSeen();
  }

  function rememberLocally(userId) { try { localStorage.setItem(SEEN_KEY + ':' + userId, '1'); } catch (e) {} }

  function markSeen() {
    if (typeof supabaseClient === 'undefined') return;
    supabaseClient.auth.getUser().then(function (res) {
      var user = res && res.data && res.data.user;
      if (!user) return;
      rememberLocally(user.id);
      if (user.user_metadata && user.user_metadata.tour_seen) return;
      var next = Object.assign({}, user.user_metadata || {}, { tour_seen: true });
      if (typeof currentUserMetadata !== 'undefined' && currentUserMetadata) currentUserMetadata = Object.assign({}, currentUserMetadata, { tour_seen: true });
      return supabaseClient.auth.updateUser({ data: next });
    }).catch(function () {});
  }

  function startIndexForPage() {
    if (!PAGE || PAGE === 'dashboard') return 0;
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].page === PAGE) return i;
    return 0;
  }

  // ---------- Settings entry ----------
  function injectMenuItem() {
    var help = document.getElementById('help-faq-btn');
    if (!help || document.getElementById('tour-open-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'tour-open-btn';
    btn.className = 'dropdown-item';
    btn.textContent = 'Take the tour';
    help.parentNode.insertBefore(btn, help);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var dd = document.getElementById('settings-dropdown');
      if (dd) dd.classList.remove('open');
      open(startIndexForPage());
    });
  }

  // ---------- first-visit auto start ----------
  function somethingElseOpen() {
    return !!document.querySelector('.mfa-overlay.open, .vault-overlay.open, .history-overlay.open, .idle-overlay.open, .arko-dialog-overlay.open, #arko-dialog-overlay.open, .feature-preview-overlay.open');
  }
  function pageReady() {
    var main = document.getElementById('dash-main');
    return main && main.style.display !== 'none' && getComputedStyle(main).display !== 'none';
  }
  function maybeAutoStart() {
    if (/[?&]tour=1\b/.test(location.search)) { waitThenOpen(startIndexForPage(), false); return; }
    if (PAGE !== 'dashboard') return;
    if (typeof supabaseClient === 'undefined') return;
    supabaseClient.auth.getSession().then(function (res) {
      var user = res && res.data && res.data.session && res.data.session.user;
      if (!user) return;
      try { if (localStorage.getItem(SEEN_KEY + ':' + user.id) === '1') return; } catch (e) {}
      if (user.user_metadata && user.user_metadata.tour_seen) { rememberLocally(user.id); return; }
      if (!user.created_at || Date.parse(user.created_at) < TOUR_LAUNCH) return; // existing accounts: available from Settings, not pushed
      waitThenOpen(0, true);
    }).catch(function () {});
  }
  function waitThenOpen(i, needDashboard) {
    var tries = 0;
    (function poll() {
      tries++;
      var ready = (!needDashboard || pageReady()) && !somethingElseOpen() && document.body;
      if (ready) { setTimeout(function () { if (!somethingElseOpen()) open(i); else poll(); }, 700); return; }
      if (tries < 90) setTimeout(poll, 400);
    })();
  }

  function init() {
    injectMenuItem();
    maybeAutoStart();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ArkoTour = { open: open, close: close };
})();
