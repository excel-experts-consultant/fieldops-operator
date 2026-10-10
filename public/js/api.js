/* Shared API client for the superadmin console and the operator app.
   Inside the Android build the page is served from the APK itself, so calls
   must go to the deployed Pages URL. Set it ONCE here after you create the
   Cloudflare Pages project, then rebuild the APK. */

window.FIELDOPS_API = 'https://fieldops-operator.pages.dev';

const BASE = (window.Capacitor || location.protocol === 'file:') ? window.FIELDOPS_API : '';

const store = {
  get token() { return localStorage.getItem('fop_token'); },
  set token(v) { v ? localStorage.setItem('fop_token', v) : localStorage.removeItem('fop_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('fop_user')); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('fop_user', JSON.stringify(v)) : localStorage.removeItem('fop_user'); },
  clear() { this.token = null; this.user = null; },
};

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + '/api' + path, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        ...(store.token ? { authorization: 'Bearer ' + store.token } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    const err = new Error('network');
    err.offline = true;
    throw err;
  }
  let data;
  try { data = await res.json(); } catch { data = { ok: false, error: 'Server did not respond properly' }; }
  if (res.status === 401) {
    store.clear();
    if (!/index\.html$/.test(location.pathname) && location.pathname !== '/') location.href = './index.html';
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

function requireRole(role) {
  const user = store.user;
  if (!store.token || !user || user.role !== role) { location.href = './index.html'; return null; }
  return user;
}

function signOut() { store.clear(); location.href = './index.html'; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
