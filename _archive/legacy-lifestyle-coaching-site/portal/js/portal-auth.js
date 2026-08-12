const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed with status ${response.status}.`);
  return data;
}

/* ── Login page ── */
const loginForm = $('[data-login-form]');
if (loginForm) {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('[data-login-message]');
    const button = loginForm.querySelector('button[type=submit]');
    button.disabled = true;
    message.hidden = false; message.className = 'form-message'; message.textContent = 'Signing in…';
    try {
      await api('/api/portal/login', { method: 'POST', body: JSON.stringify({ email: loginForm.email.value, password: loginForm.password.value }) });
      window.location.href = 'dashboard.html';
    } catch (error) {
      message.className = 'form-message error';
      message.textContent = error.message;
      button.disabled = false;
    }
  });
}

/* ── Activation page ── */
const activateLoading = $('[data-activate-loading]');
const activateFormWrap = $('[data-activate-form]');
const activateErrorWrap = $('[data-activate-error]');
const setPasswordForm = $('[data-set-password-form]');

if (activateLoading) {
  (async () => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const token = params.get('token');

    if (!sessionId && !token) {
      showActivateError('This activation link is missing required information. Please use the link from your confirmation email or contact your coach.');
      return;
    }

    try {
      const data = await api('/api/portal/activate', { method: 'POST', body: JSON.stringify({ session_id: sessionId || undefined, token: token || undefined }) });
      if (data.already_has_password) {
        showActivateError('This account has already been activated. Please sign in with your existing password.');
        return;
      }
      activateLoading.hidden = true;
      activateFormWrap.hidden = false;
      $('[data-activate-lead]').textContent = `Create a password for ${data.email} to finish setting up your client portal.`;
      setPasswordForm.dataset.activationToken = data.activation_token;
    } catch (error) {
      showActivateError(error.message);
    }
  })();

  setPasswordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('[data-activate-message]');
    const button = setPasswordForm.querySelector('button[type=submit]');
    const password = setPasswordForm.password.value;
    const confirmPassword = setPasswordForm.confirmPassword.value;
    message.hidden = false; message.className = 'form-message'; message.textContent = '';

    if (password !== confirmPassword) {
      message.className = 'form-message error';
      message.textContent = 'Passwords do not match.';
      return;
    }

    button.disabled = true;
    message.textContent = 'Setting up your portal…';
    try {
      await api('/api/portal/set-password', { method: 'POST', body: JSON.stringify({ token: setPasswordForm.dataset.activationToken, password }) });
      window.location.href = 'dashboard.html';
    } catch (error) {
      message.className = 'form-message error';
      message.textContent = error.message;
      button.disabled = false;
    }
  });
}

function showActivateError(text) {
  activateLoading.hidden = true;
  activateFormWrap.hidden = true;
  activateErrorWrap.hidden = false;
  $('[data-activate-error-text]').textContent = text;
}
