/* ============= TRUSTED DEVICES + FASTER 2FA ENTRY =============
   Shared by every page with the two-factor overlay (Dashboard, Budget,
   Log, Spendings, Connections). Three jobs:

   1. "Trust this device for 30 days" — a checkbox added under the code
      field. When it's checked and the code verifies, this browser makes
      a random secret, keeps it in localStorage, and registers only its
      hash with the server (lib/device-trust.js, which refuses unless the
      session has just passed a real code check). Each page's
      requireMfaVerified() asks isTrusted() before prompting.
   2. Quicker code entry — the field is focused automatically, ignores
      anything but digits, and submits itself on the 6th digit (or Enter).
   3. A "Trusted devices" list in Manage 2FA, with Forget / Forget all.

   Like ambient.js and menu-icons.js, it reads the page's own global
   `supabaseClient` at call time and decorates the existing modal by
   element id, so none of the five copies of the MFA code needed more
   than a one-line hook. */
(function () {
  var STORE_KEY = 'arko_device_trust';
  var API = '/api/plaid-item-actions';
  var pendingTrust = null; // { at } — set when a verify button is pressed with the box checked
  var lastAutoSubmit = '';

  function client() { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeLocal(v) {
    try { v ? localStorage.setItem(STORE_KEY, JSON.stringify(v)) : localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  function sha256Hex(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }
  function randomSecret() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function deviceLabel() {
    var ua = navigator.userAgent;
    var browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    var os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? browser + ' on ' + os : browser;
  }

  function liveRecords(user) {
    var list = (user && user.app_metadata && user.app_metadata.trusted_devices) || [];
    var now = Date.now();
    return list.filter(function (d) { return d && Date.parse(d.exp) > now; });
  }

  // True only if this browser holds a secret whose hash matches a live,
  // unexpired server record for this user, minted by an authenticator
  // that's still enrolled. Reads the user fresh from the auth server, so
  // a device forgotten elsewhere stops working immediately.
  function isTrusted() {
    var sb = client();
    var local = readLocal();
    if (!sb || !local || !local.secret || !local.deviceId || !window.crypto || !crypto.subtle) return Promise.resolve(false);
    return sb.auth.getUser().then(function (res) {
      var user = res && res.data && res.data.user;
      if (!user || user.id !== local.userId) return false;
      var record = liveRecords(user).find(function (d) { return d.id === local.deviceId; });
      if (!record) return false;
      var factorOk = (user.factors || []).some(function (f) { return f.id === record.factor && f.status === 'verified'; });
      if (!factorOk) return false;
      return sha256Hex(local.secret).then(function (h) { return h === record.hash; });
    }).catch(function () { return false; });
  }

  function authHeaderFor(sb) {
    return sb.auth.getSession().then(function (res) {
      var s = res && res.data && res.data.session;
      return s ? { 'Authorization': 'Bearer ' + s.access_token } : {};
    });
  }

  // Called right after a code verifies, with the new AAL2 session the
  // verify event carries — no extra network round-trip first, since the
  // page often navigates straight to Connections. keepalive lets the
  // request itself finish even if that navigation happens mid-flight.
  function trustThisDevice(session) {
    var user = session && session.user;
    if (!user || !session.access_token || !window.crypto || !crypto.subtle || !crypto.randomUUID) return Promise.resolve();
    var pickFactor = function (factors) {
      return (factors || []).filter(function (f) { return f.status === 'verified' && f.factor_type === 'totp'; })
        .sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); })[0];
    };
    var factor = pickFactor(user.factors);
    if (!factor) {
      // Shouldn't happen (the verify response's user lists its factors),
      // but fall back to asking rather than silently not trusting.
      var sb = client();
      if (!sb) return Promise.resolve();
      return sb.auth.mfa.listFactors().then(function (res) {
        var f = pickFactor(res && res.data && res.data.totp);
        if (f) { user = Object.assign({}, user, { factors: [f] }); return trustThisDevice({ user: user, access_token: session.access_token }); }
      }).catch(function () {});
    }
    var deviceId = crypto.randomUUID();
    var secret = randomSecret();
    writeLocal({ userId: user.id, deviceId: deviceId, secret: secret });
    return sha256Hex(secret).then(function (hash) {
      return fetch(API, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ action: 'trust_device', deviceId: deviceId, hash: hash, factorId: factor.id, label: deviceLabel() }),
      });
    }).catch(function (err) { console.error('Could not trust device:', err); });
  }

  function forget(deviceIdOrAll) {
    var sb = client();
    if (!sb) return Promise.resolve();
    var local = readLocal();
    var all = deviceIdOrAll === 'all';
    if (local && (all || local.deviceId === deviceIdOrAll)) writeLocal(null);
    return authHeaderFor(sb).then(function (h) {
      return fetch(API, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, h),
        body: JSON.stringify(all ? { action: 'untrust_device', all: true } : { action: 'untrust_device', deviceId: deviceIdOrAll }),
      });
    }).then(function () { return sb.auth.refreshSession(); }).catch(function (err) { console.error('Could not forget device:', err); });
  }

  // ---------- modal decoration ----------
  var VERIFY_BTN_IDS = ['mfa-session-verify-btn', 'mfa-enroll-verify-btn'];
  var CODE_INPUT_IDS = ['mfa-verify-code', 'mfa-remove-verify-code'];

  function decorateModal(body) {
    var input = CODE_INPUT_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean)[0];
    if (input && !input.dataset.arkoFocused) {
      input.dataset.arkoFocused = '1';
      lastAutoSubmit = '';
      setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }, 60);
    }

    var verifyBtn = VERIFY_BTN_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean)[0];
    if (verifyBtn && !document.getElementById('mfa-trust-device')) {
      var row = document.createElement('label');
      row.className = 'mfa-trust-row';
      row.innerHTML = '<input type="checkbox" id="mfa-trust-device" checked />' +
        '<span class="mfa-trust-text"><span class="mfa-trust-title">Trust this device for 30 days</span>' +
        '<span class="mfa-trust-sub">Skip the code here until then. Leave unchecked on a shared computer.</span></span>';
      verifyBtn.parentNode.insertBefore(row, verifyBtn);
    }

    var factorList = body.querySelector('.mfa-factor-list');
    if (factorList && !body.querySelector('.mfa-trusted-section')) renderTrustedSection(body);
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function renderTrustedSection(body) {
    var sb = client();
    if (!sb) return;
    var section = document.createElement('div');
    section.className = 'mfa-trusted-section';
    section.innerHTML = '<span class="mfa-trusted-head">Trusted devices</span><p class="mfa-modal-sub mfa-trusted-loading">Loading…</p>';
    body.appendChild(section);

    sb.auth.getUser().then(function (res) {
      var user = res && res.data && res.data.user;
      var verifiedFactors = ((user && user.factors) || []).filter(function (f) { return f.status === 'verified'; }).map(function (f) { return f.id; });
      var devices = liveRecords(user).filter(function (d) { return verifiedFactors.indexOf(d.factor) !== -1; });
      var local = readLocal();
      var thisId = local && local.userId === (user && user.id) ? local.deviceId : null;

      if (!devices.length) {
        section.innerHTML = '<span class="mfa-trusted-head">Trusted devices</span>' +
          '<p class="mfa-modal-sub">None yet. Check “Trust this device” the next time you enter a code to skip it on that device for 30 days.</p>';
        return;
      }
      devices.sort(function (a, b) { return (b.id === thisId) - (a.id === thisId) || b.created.localeCompare(a.created); });
      section.innerHTML = '<div class="mfa-trusted-head-row"><span class="mfa-trusted-head">Trusted devices</span>' +
        (devices.length > 1 ? '<button type="button" class="mfa-trusted-forget-all">Forget all</button>' : '') + '</div>' +
        '<div class="mfa-factor-list">' + devices.map(function (d) {
          return '<div class="mfa-factor-row mfa-trusted-row">' +
            '<span class="mfa-trusted-info"><span>' + esc(d.label || 'Browser') + (d.id === thisId ? ' <span class="mfa-trusted-this">This device</span>' : '') + '</span>' +
            '<span class="mfa-trusted-meta">Trusted until ' + fmtDate(d.exp) + '</span></span>' +
            '<button type="button" class="mfa-trusted-forget" data-id="' + esc(d.id) + '">Forget</button></div>';
        }).join('') + '</div>';

      section.querySelectorAll('.mfa-trusted-forget').forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true; btn.textContent = 'Forgetting…';
          forget(btn.dataset.id).then(function () { section.remove(); renderTrustedSection(body); });
        });
      });
      var allBtn = section.querySelector('.mfa-trusted-forget-all');
      if (allBtn) allBtn.addEventListener('click', function () {
        allBtn.disabled = true; allBtn.textContent = 'Forgetting…';
        forget('all').then(function () { section.remove(); renderTrustedSection(body); });
      });
    });
  }

  function setup() {
    var body = document.getElementById('mfa-modal-body');
    if (!body) return;

    new MutationObserver(function () { decorateModal(body); }).observe(body, { childList: true, subtree: true });

    // Digits only; submit on the 6th. lastAutoSubmit stops Enter (or a
    // re-render) from firing a second verify for the same code.
    document.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || CODE_INPUT_IDS.indexOf(el.id) === -1) return;
      var digits = el.value.replace(/\D/g, '').slice(0, 6);
      if (digits !== el.value) el.value = digits;
      if (digits.length === 6 && digits !== lastAutoSubmit) {
        lastAutoSubmit = digits;
        var btn = el.closest('.mfa-modal-body').querySelector('.mfa-verify-btn');
        if (btn && !btn.disabled) btn.click();
      }
    });
    document.addEventListener('keydown', function (e) {
      var el = e.target;
      if (e.key !== 'Enter' || !el || CODE_INPUT_IDS.indexOf(el.id) === -1) return;
      e.preventDefault();
      if (el.value === lastAutoSubmit) return;
      lastAutoSubmit = el.value;
      var btn = el.closest('.mfa-modal-body').querySelector('.mfa-verify-btn');
      if (btn && !btn.disabled) btn.click();
    });
    // A wrong code leaves the field filled — let a corrected entry re-submit.
    document.addEventListener('focusin', function (e) {
      if (e.target && CODE_INPUT_IDS.indexOf(e.target.id) !== -1 && e.target.value.length < 6) lastAutoSubmit = '';
    });

    // Remember the checkbox at the moment of verifying (capture phase, so
    // it runs before the page's own handler re-renders the modal).
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      if (VERIFY_BTN_IDS.indexOf(btn.id) !== -1) {
        var box = document.getElementById('mfa-trust-device');
        pendingTrust = box && box.checked ? { at: Date.now() } : null;
      } else if (btn.id === 'mfa-remove-verify-btn') {
        pendingTrust = null;
      }
    }, true);

    var sb = client();
    if (sb) {
      sb.auth.onAuthStateChange(function (event, session) {
        if (event !== 'MFA_CHALLENGE_VERIFIED' || !pendingTrust || Date.now() - pendingTrust.at > 120000) return;
        pendingTrust = null;
        trustThisDevice(session);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();

  // Sent to our own API on 2FA-protected calls so the server can accept a
  // trusted device in place of a fresh code (lib/auth-guard.js checks it
  // against the hash it stored). Empty when this browser isn't trusted.
  function proofHeader() {
    var local = readLocal();
    return local && local.deviceId && local.secret ? { 'X-Arko-Device': local.deviceId + '.' + local.secret } : {};
  }

  window.ArkoDeviceTrust = { isTrusted: isTrusted, forget: forget, proofHeader: proofHeader };
})();
