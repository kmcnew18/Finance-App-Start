/* Show/hide toggle for every password field on the sign-in pages
   (login, signup, reset password). Typos in a hidden field are the most
   common reason a login fails on a phone; one tap reveals what was typed.
   The field goes back to hidden when the form submits. */
(function () {
  var EYE = '<svg class="pw-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  var EYE_OFF = '<svg class="pw-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.3 20.3 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a20.3 20.3 0 0 1-2.16 3.19"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><path d="M1 1l22 22"></path></svg>';

  function enhance(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    var wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = EYE + EYE_OFF;
    wrap.appendChild(btn);

    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      // Keep the cursor where it was so typing can continue.
      var pos = input.value.length;
      input.focus();
      try { input.setSelectionRange(pos, pos); } catch (e) {}
    });
    if (input.form) {
      input.form.addEventListener('submit', function () {
        input.type = 'password';
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', 'Show password');
      });
    }
  }

  function init() { document.querySelectorAll('input[type="password"]').forEach(enhance); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
