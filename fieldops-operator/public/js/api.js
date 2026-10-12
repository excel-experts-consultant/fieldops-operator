/* Shared API client for the superadmin console and the operator app.
   Inside the Android build the page is served from the APK itself, so calls
   must go to the deployed Pages URL. Set it ONCE here after you create the
   Cloudflare Pages project, then rebuild the APK. */

window.FIELDOPS_API = 'https://fieldops-operator.pages.dev';

const BASE = (window.Capacitor || location.protocol === 'file:') ? window.FIELDOPS_API : '';

/* A per-installation id so the superadmin can see when one account is signed in
   on more than one phone. It identifies the install, not the person: it is made
   once, kept in this app's own storage, and is not tied to any hardware id.
   Reinstalling the app or clearing its data produces a new one. */
const DEVICE_KEY = 'fop_device_id';
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9._-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2))
        .replace(/[^A-Za-z0-9._-]/g, '');
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch { return null; }   // private window or storage blocked
}
const devicePlatform = () => (window.Capacitor ? 'android' : 'web');

const store = {
  get token() { return localStorage.getItem('fop_token'); },
  set token(v) { v ? localStorage.setItem('fop_token', v) : localStorage.removeItem('fop_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('fop_user')); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('fop_user', JSON.stringify(v)) : localStorage.removeItem('fop_user'); },
  clear() { this.token = null; this.user = null; },
};

/* A request that never answers is worse than one that fails: on a weak signal a
   fetch can hang indefinitely, and the screen sits on "जमा हो रहा है…" forever.
   Every call gets a deadline. Giving up is safe — an entry carries a
   client_uuid, so the phone can resend it and the server recognises it as the
   same one instead of writing it to the sheet twice. */
const TIMEOUT_MS = 20000;

async function api(path, options = {}) {
  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), options.timeout || TIMEOUT_MS);
  try {
    res = await fetch(BASE + '/api' + path, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        ...(store.token ? { authorization: 'Bearer ' + store.token } : {}),
        ...(deviceId() ? { 'x-device-id': deviceId() } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: ctl.signal,
    });
  } catch {
    const err = new Error('network');
    err.offline = true;
    err.timeout = ctl.signal.aborted;   // the server was reachable but too slow
    throw err;
  } finally {
    clearTimeout(timer);
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
    err.code = data.code;          // e.g. 'device_pending' when a new phone awaits approval
    err.data = data;
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
