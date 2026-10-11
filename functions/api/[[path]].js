/**
 * FieldOps Operator API — Cloudflare Pages Functions (no build step, no dependencies).
 * Every route below lives under /api/...
 *
 * Bindings (wrangler.toml / Pages dashboard):
 *   DB                      D1 database
 *   SESSION_SECRET          secret, any long random string
 *   GOOGLE_SERVICE_ACCOUNT  secret, the full service-account JSON
 *   SHEET_ID                var, the spreadsheet id
 *   SHEET_TAB               var, where entries are written (default "TNK FD")
 *   FLREP_TAB               var, the read-only report tab (default "FL Rep")
 *   ENTRY_CODE              var, written to column L of every entry (default "RKP-45BT2")
 *   FLREP_TTL_SECONDS       var, how long one read of FL Rep is shared (default 60, minimum 30)
 *   TIMEZONE                var, default "Asia/Kolkata"
 *
 * Google allows one service account 60 reads and 60 writes a minute in total,
 * however many people use the app. Two things keep 300–400 employees inside that:
 *   - FL Rep is fetched by one request at a time and shared through D1.
 *   - Entries are saved to D1 first and written to the sheet in batches,
 *     costing one read + one write per batch no matter how many are waiting.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const fail = (message, status = 400) => json({ ok: false, error: message }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ crypto */

const enc = new TextEncoder();
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password, saltHex, iterations = 100000) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return hex(bits);
}

export async function hashPassword(password) {
  const saltHex = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$100000$${saltHex}$${await pbkdf2(password, saltHex)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iters, saltHex, digest] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !saltHex || !digest) return false;
  const check = await pbkdf2(password, saltHex, Number(iters));
  if (check.length !== digest.length) return false;
  let diff = 0;
  for (let i = 0; i < check.length; i++) diff |= check.charCodeAt(i) ^ digest.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

async function signToken(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}

async function readToken(env, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if ((await hmac(env.SESSION_SECRET, body)) !== sig) return null;
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

async function requireUser(request, env, role) {
  const header = request.headers.get('authorization') || '';
  const session = await readToken(env, header.replace(/^Bearer\s+/i, ''));
  if (!session) return null;
  if (role && session.role !== role) return null;
  const user = await env.DB.prepare(
    'SELECT id, username, name, role, active, token_version FROM users WHERE id = ?',
  ).bind(session.uid).first();
  if (!user || !user.active) return null;
  // "Sign out all devices" bumps token_version, which retires every token issued before it.
  if (Number(session.tv || 0) !== Number(user.token_version || 0)) return null;
  return user;
}

/* ------------------------------------------------------------------ devices */

/** A short, human label from the browser/WebView user agent. No IP is stored. */
function deviceLabel(ua) {
  const u = String(ua || '');
  const android = /Android\s+([\d.]+)[^)]*?;\s*([^;)]+?)(?:\s+Build\/|\))/i.exec(u);
  if (android) return `Android ${android[1]} · ${android[2].trim()}`.slice(0, 60);
  if (/Android/i.test(u)) return 'Android phone';
  if (/iPhone|iPad|iPod/i.test(u)) return /iPad/i.test(u) ? 'iPad' : 'iPhone';
  const browser = /(Edg|OPR|Chrome|Firefox|Safari)\/[\d.]+/i.exec(u);
  const os = /Windows NT/i.test(u) ? 'Windows' : /Mac OS X/i.test(u) ? 'Mac'
    : /Linux/i.test(u) ? 'Linux' : '';
  const name = browser ? { Edg: 'Edge', OPR: 'Opera' }[browser[1]] || browser[1] : 'Browser';
  return [name, os].filter(Boolean).join(' on ').slice(0, 60) || 'Unknown device';
}

const cleanDeviceId = (v) => {
  const d = String(v || '').trim();
  return /^[A-Za-z0-9._-]{8,64}$/.test(d) ? d : null;
};

/** Record a sign-in from this device, or bump its counters if already known. */
async function recordDevice(env, request, body, userId) {
  const id = cleanDeviceId(body.device_id);
  if (!id) return;
  const ua = request.headers.get('user-agent') || '';
  const platform = body.platform === 'android' || /wv\)/.test(ua) ? 'android' : 'web';
  await env.DB.prepare(`
    INSERT INTO devices (employee_id, device_id, label, platform)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(employee_id, device_id) DO UPDATE SET
      last_seen = datetime('now'), logins = logins + 1,
      label = excluded.label, platform = excluded.platform
  `).bind(userId, id, deviceLabel(ua), platform).run();
}

/**
 * Keep last_seen roughly current without a database write on every request:
 * only write when the stored value is already more than 30 minutes old.
 */
async function touchDevice(env, request, userId) {
  const id = cleanDeviceId(request.headers.get('x-device-id'));
  if (!id) return;
  const row = await env.DB.prepare(
    "SELECT 1 AS stale FROM devices WHERE employee_id = ? AND device_id = ? AND last_seen < datetime('now','-30 minutes')",
  ).bind(userId, id).first();
  if (!row) return;
  await env.DB.prepare(
    "UPDATE devices SET last_seen = datetime('now') WHERE employee_id = ? AND device_id = ?",
  ).bind(userId, id).run();
}

const USERNAME_RE = /^[a-z0-9._-]{3,}$/;

/* ------------------------------------------------------------------- locks */

/**
 * A short lease in D1 so only one request at a time does a given job.
 * Returns a token to release with, or 0 if someone else holds it.
 * One UPSERT statement, so taking the lease is atomic.
 */
async function tryLock(env, name, ms) {
  const now = Date.now();
  const until = now + ms;
  const r = await env.DB.prepare(`
    INSERT INTO locks (name, until) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET until = excluded.until WHERE locks.until < ?
  `).bind(name, until, now).run();
  return (r.meta?.changes || 0) > 0 ? until : 0;
}

/** Only frees the lease if it is still ours (it may have expired and been retaken). */
async function releaseLock(env, name, token) {
  await env.DB.prepare('DELETE FROM locks WHERE name = ? AND until = ?').bind(name, token).run();
}

/* ------------------------------------------------------------------ kv */

async function kvGet(env, key) {
  const row = await env.DB.prepare('SELECT value, updated_at FROM kv WHERE key = ?').bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function kvSet(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, JSON.stringify(value), Date.now()).run();
}

/*
 * The FL Rep copy can be large (≈250 bytes a site, so ~500 KB at 2,000 sites).
 * D1 caps a statement at 100 KB and its docs don't say whether a bound value
 * counts toward that, so the copy is stored in pieces that fit even if it does:
 * 30,000 characters is at most 90 KB of UTF-8. One batch = one transaction,
 * so a reader never sees half of an old copy and half of a new one.
 */
const REPORT_CHUNK = 30000;

async function saveReport(env, report) {
  const text = JSON.stringify(report);
  const parts = [];
  for (let i = 0; i < text.length; i += REPORT_CHUNK) parts.push(text.slice(i, i + REPORT_CHUNK));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kv WHERE key LIKE 'flrep#%'"),
    ...parts.map((p, i) => env.DB.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(`flrep#${String(i).padStart(4, '0')}`, p, now)),
    env.DB.prepare(`
      INSERT INTO kv (key, value, updated_at) VALUES ('flrep', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(JSON.stringify({ parts: parts.length, fetched_at: report.fetched_at }), now),
  ]);
}

async function loadReport(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM kv WHERE key = 'flrep' OR key LIKE 'flrep#%' ORDER BY key",
  ).all();
  const head = results.find((r) => r.key === 'flrep');
  if (!head) return null;
  try {
    const meta = JSON.parse(head.value);
    const parts = results.filter((r) => r.key !== 'flrep');
    if (parts.length !== meta.parts) return null;
    const report = JSON.parse(parts.map((p) => p.value).join(''));
    report.fetched_at = meta.fetched_at;
    return report;
  } catch { return null; }
}

/* ----------------------------------------------------------- google sheets */

let tokenCache = { value: null, exp: 0 };

function pemToBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function googleToken(env) {
  if (tokenCache.value && tokenCache.exp > Date.now() + 60000) return tokenCache.value;
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw new Error('GOOGLE_SERVICE_ACCOUNT is not configured');
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claim}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
  tokenCache = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

const sheetsUrl = (env, path) =>
  `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}${path}`;

/** A1 sheet reference that is safe for any tab name, e.g. 'TNK FD'. */
const tabRef = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

async function sheets(env, path, init = {}) {
  const token = await googleToken(env);
  const res = await fetch(sheetsUrl(env, path), {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...JSON_HEADERS, ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(res.status === 429
      ? 'Google Sheets is busy (too many requests); will retry shortly'
      : data.error?.message || `Google Sheets error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Anything an employee or admin typed goes into the sheet with USER_ENTERED,
 * which would run it as a formula if it started with = + - or @.
 * A leading apostrophe makes Sheets keep it as plain text.
 */
const asSheetText = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};

/* ------------------------------------------------------------------ time */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Column A stamp for an instant, e.g. "09 OCT 26 19:02:00". */
function stampAt(date, tz = 'Asia/Kolkata') {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year} ${hour}:${p.minute}:${p.second}`;
}

/** Start of today in `tz`, as D1's "YYYY-MM-DD HH:MM:SS" UTC text. */
function localMidnightUtc(tz = 'Asia/Kolkata') {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - now.getTime();
  const midnightUtc = Date.UTC(p.year, p.month - 1, p.day) - offset;
  return new Date(midnightUtc).toISOString().replace('T', ' ').slice(0, 19);
}

/* ------------------------------------------------------------ FL Rep report */

/*
 * The report columns, in display order. Colours come from the sheet itself:
 * the Sheets API returns each cell's effective format WITH conditional
 * formatting applied, so the app shows exactly what the sheet shows and
 * keeps up if the rules change. RULES below copy the sheet's rules as they
 * were set up, and are only used if the sheet sends back no colours at all.
 */
const REPORT_COLUMNS = ['Service', 'Tank Diesel Left', 'DSL%', 'Battery', 'Fuel Motor']; // sheet C..G

const GREEN = '#00ff00';
const PINK = '#ea9999';   // Sheets "light red 2"
const RED = '#e06666';    // Sheets "light red 1"
const ORANGE = '#ff9900';
const CYAN = '#00ffff';

const between = (n, lo, hi) => n !== null && n >= lo && n <= hi;
const has = (text, needle) => String(text).toLowerCase().includes(needle); // Sheets "text contains" ignores case

const RULES = [
  /* C Service */ (n) => (between(n, -10000, 900) ? GREEN : between(n, 900.01, 2500) ? PINK : null),
  /* D Tank    */ (n) => (between(n, -10000, 125) ? PINK : between(n, 125.01, 3000) ? GREEN : null),
  /* E DSL%    */ (n, t) => (between(n, 0, 24.99) ? RED : between(n, 25, 50.99) ? ORANGE
    : between(n, 51, 2300) ? GREEN : has(t, 'fault') ? RED : null),
  /* F Battery */ (n) => (n === null ? null : n < 13 ? PINK : between(n, 13.01, 14.8) ? GREEN : n > 14.8 ? PINK : null),
  /* G Fuel    */ (n, t) => (has(t, 'no tank') ? CYAN : has(t, 'stop') ? PINK : has(t, '-') ? GREEN : null),
];

function cellHex(cell) {
  const f = cell?.effectiveFormat;
  const c = f?.backgroundColorStyle?.rgbColor || f?.backgroundColor;
  if (!c) return null;
  const to = (x) => Math.round(Math.min(1, Math.max(0, x || 0)) * 255).toString(16).padStart(2, '0');
  const h = `#${to(c.red)}${to(c.green)}${to(c.blue)}`;
  return h === '#ffffff' ? null : h;
}

const siteCode = (name) => {
  const m = /^\s*([A-Za-z0-9]+)_/.exec(String(name || ''));
  return m ? m[1].toUpperCase() : null;
};
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Turn the raw grid into sites. A site row has a serial number in column A
    and a name in B; a row with only a name in B is a section heading. */
function parseReport(rowData) {
  const sites = [];
  let group = '';
  let sheetColours = false;
  rowData.forEach((row, i) => {
    const v = row.values || [];
    const a = String(v[0]?.formattedValue ?? '').trim();
    const b = String(v[1]?.formattedValue ?? '').trim();
    if (!b) return;
    if (/^\d+(\.0+)?$/.test(a)) {
      const cells = [2, 3, 4, 5, 6].map((c) => {
        const cell = v[c] || {};
        const bg = cellHex(cell);
        if (bg) sheetColours = true;
        const num = typeof cell.effectiveValue?.numberValue === 'number' ? cell.effectiveValue.numberValue : null;
        return { v: String(cell.formattedValue ?? ''), n: num, bg };
      });
      sites.push({ row: i + 1, sl: Number(a), name: b, code: siteCode(b), group, cells });
    } else if (!a && i > 0) {
      group = b;
    }
  });

  // Fall back to the copied rules only if the sheet gave us no colours at all.
  if (!sheetColours) {
    for (const s of sites) {
      s.cells.forEach((c, i) => { c.bg = RULES[i](c.n, c.v); });
    }
  }
  for (const s of sites) for (const c of s.cells) delete c.n;
  return { sites, colours: sheetColours ? 'sheet' : 'rules' };
}

async function fetchReport(env) {
  const tab = env.FLREP_TAB || 'FL Rep';
  const fields = 'sheets(data(rowData(values(formattedValue,effectiveValue,'
    + 'effectiveFormat(backgroundColor,backgroundColorStyle)))))';
  const data = await sheets(env,
    `?ranges=${encodeURIComponent(`${tabRef(tab)}!A1:G`)}&fields=${encodeURIComponent(fields)}`);
  const rowData = data.sheets?.[0]?.data?.[0]?.rowData || [];
  return { fetched_at: Date.now(), ...parseReport(rowData) };
}

let memReport = null;

/**
 * The report, at most FLREP_TTL_SECONDS old. When it is stale exactly one
 * request fetches a fresh copy from Google; everyone else is handed the
 * copy already in D1 rather than waiting or adding to the Google quota.
 */
async function getReport(env, { force = false } = {}) {
  const ttl = Math.max(30, Number(env.FLREP_TTL_SECONDS || 60)) * 1000;
  const fresh = (r) => r && Date.now() - r.fetched_at < ttl;

  if (!force && fresh(memReport)) return memReport;
  let snap = await loadReport(env);
  if (!force && fresh(snap)) { memReport = snap; return snap; }

  const lease = await tryLock(env, 'flrep', 25000);
  if (lease) {
    // Another request may have refreshed it between our check and taking the
    // lease. Look again before spending a Google read. (A forced refresh still
    // reuses a copy from the last few seconds, so double-clicks cost nothing.)
    const again = await loadReport(env);
    if (again && (force ? Date.now() - again.fetched_at < 3000 : fresh(again))) {
      await releaseLock(env, 'flrep', lease);
      memReport = again;
      return again;
    }
    try {
      const next = await fetchReport(env);
      await saveReport(env, next);
      await releaseLock(env, 'flrep', lease);
      memReport = next;
      return next;
    } catch (err) {
      // Keep the lease: it doubles as a short back-off before Google is tried again.
      if (snap) return { ...snap, error: err.message };
      throw err;
    }
  }
  if (snap) return snap;
  // First ever load and another request is already fetching it.
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    snap = await loadReport(env);
    if (snap) return snap;
  }
  throw new Error('The site report is still loading. Try again in a moment.');
}

/** Match stored allocations to rows in the report: by name, then by site code. */
function matchSites(report, access) {
  const byName = new Map(report.sites.map((s) => [normName(s.name), s]));
  const codeCount = new Map();
  for (const s of report.sites) if (s.code) codeCount.set(s.code, (codeCount.get(s.code) || 0) + 1);
  const byCode = new Map(report.sites.filter((s) => s.code && codeCount.get(s.code) === 1).map((s) => [s.code, s]));

  const seen = new Set();
  const matched = [];
  const missing = [];
  for (const a of access) {
    const s = byName.get(normName(a.site_name)) || (a.site_code && byCode.get(String(a.site_code).toUpperCase()));
    if (!s) { missing.push(a.site_name); continue; }
    if (seen.has(s.row)) continue;
    seen.add(s.row);
    matched.push({ site: s, stored: a });
  }
  matched.sort((x, y) => x.site.row - y.site.row);
  return { matched, missing };
}

/** Allocation rows pointing at one report site: by its name, or by its code
    when the stored name no longer exists in the sheet (the site was renamed). */
async function siteHolders(env, report, site) {
  const { results } = await env.DB.prepare(`
    SELECT employee_id, site_name, site_code FROM site_access
    WHERE site_name = ? OR (site_code IS NOT NULL AND site_code = ?)
  `).bind(site.name, site.code).all();
  return results.filter((r) => matchSites(report, [r]).matched[0]?.site.row === site.row);
}

/* ---------------------------------------------------- entries → the sheet */

const BATCH = 200;

async function nextFreeRow(env, tab) {
  const data = await sheets(env, `/values/${encodeURIComponent(`${tabRef(tab)}!A:A`)}`);
  return (data.values?.length || 0) + 1;
}

/**
 * Write every pending entry to the sheet, oldest first, in batches.
 * Each batch costs one Google read (find the next free row) and one write
 * (all its cells at once). The lease makes sure two batches can never pick
 * the same "next free row" and overwrite each other.
 *   A time · B site · D diesel filled · F generator reading · K employee · L code
 */
async function flushEntries(env) {
  const lease = await tryLock(env, 'sheet-sync', 30000);
  if (!lease) return { busy: true, synced: 0 };

  const tab = env.SHEET_TAB || 'TNK FD';
  const code = env.ENTRY_CODE || 'RKP-45BT2';
  let synced = 0;
  try {
    for (let round = 0; round < 5; round++) {
      const { results } = await env.DB.prepare(`
        SELECT id, kind, site_text, diesel_filled, generator_reading, service_reading,
               entry_stamp, employee_name
        FROM entries
        WHERE sheet_status = 'pending' ORDER BY id LIMIT ?
      `).bind(BATCH).all();
      if (!results.length) break;

      const start = await nextFreeRow(env, tab);
      const data = [];
      results.forEach((r, i) => {
        const row = start + i;
        // A service entry writes only its own reading, and carries no code.
        const cells = r.kind === 'service'
          ? {
            A: r.entry_stamp,
            B: asSheetText(r.site_text),
            J: r.service_reading,
            K: asSheetText(r.employee_name),
          }
          : {
            A: r.entry_stamp,
            B: asSheetText(r.site_text),
            D: r.diesel_filled,
            F: r.generator_reading,
            K: asSheetText(r.employee_name),
            L: asSheetText(code),
          };
        for (const [col, value] of Object.entries(cells)) {
          data.push({ range: `${tabRef(tab)}!${col}${row}`, values: [[value]] });
        }
      });
      await sheets(env, '/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });

      await env.DB.batch(results.map((r, i) => env.DB.prepare(
        "UPDATE entries SET sheet_status = 'synced', sheet_row = ? WHERE id = ?",
      ).bind(`${tab}!A${start + i}`, r.id)));
      synced += results.length;
      if (results.length < BATCH) break;
    }
  } catch (err) {
    // One status row, not one per entry: a long outage must not burn D1 writes.
    await kvSet(env, 'sync', { ok: false, error: err.message, at: Date.now(), synced });
    // Keep the lease for its 30 s as a back-off before anyone tries Google again.
    return { synced, error: err.message };
  }
  await kvSet(env, 'sync', { ok: true, error: null, at: Date.now(), synced });
  await releaseLock(env, 'sheet-sync', lease);
  return { synced };
}

/** In the background after a response: write anything still waiting. */
function kickFlush(env, ctx, delayMs = 0) {
  ctx.waitUntil((async () => {
    if (delayMs) await sleep(delayMs);
    const waiting = await env.DB.prepare(
      "SELECT 1 AS x FROM entries WHERE sheet_status = 'pending' LIMIT 1",
    ).first();
    if (waiting) await flushEntries(env);
  })().catch(() => {}));
}

/* ------------------------------------------------------------------- routes */

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = '/' + (Array.isArray(params.path) ? params.path.join('/') : params.path || '');
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      },
    });
  }

  const body = method === 'GET' ? {} : await request.json().catch(() => ({}));
  const url = new URL(request.url);

  try {
    const res = await route({ path, method, body, url, request, env, ctx: context });
    res.headers.set('access-control-allow-origin', '*'); // the Capacitor app calls from its own origin
    return res;
  } catch (err) {
    const res = fail(err.message || 'Unexpected server error', 500);
    res.headers.set('access-control-allow-origin', '*');
    return res;
  }
}

async function route({ path, method, body, url, request, env, ctx }) {
  /* ---------- auth ---------- */

  if (path === '/auth/login' && method === 'POST') {
    const username = String(body.username || '').trim().toLowerCase();
    const user = await env.DB.prepare(
      'SELECT id, username, name, role, password_hash, active, token_version FROM users WHERE username = ?',
    ).bind(username).first();
    if (!user || !user.active || !(await verifyPassword(String(body.password || ''), user.password_hash))) {
      return fail('Username or password is wrong', 401);
    }
    if (user.role === 'employee') await recordDevice(env, request, body, user.id);
    const token = await signToken(env, {
      uid: user.id, role: user.role, tv: Number(user.token_version || 0),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
    });
    return json({
      ok: true, token,
      user: { id: user.id, name: user.name, role: user.role, username: user.username },
    });
  }

  if (path === '/auth/me' && method === 'GET') {
    const user = await requireUser(request, env);
    return user ? json({ ok: true, user }) : fail('Session expired', 401);
  }

  if (path === '/auth/password' && method === 'POST') {
    const user = await requireUser(request, env);
    if (!user) return fail('Session expired', 401);
    if (String(body.password || '').length < 6) return fail('Use at least 6 characters', 400);
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
    if (!row || !(await verifyPassword(String(body.current || ''), row.password_hash))) {
      return fail('Current password is wrong', 403);
    }
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(await hashPassword(body.password), user.id).run();
    return json({ ok: true });
  }

  /* An admin changing their own display name and sign-in username. */
  if (path === '/auth/profile' && method === 'POST') {
    const user = await requireUser(request, env, 'admin');
    if (!user) return fail('Session expired', 401);
    const name = String(body.name || '').trim();
    const username = String(body.username || '').trim().toLowerCase();
    if (name.length < 2) return fail('Enter a name', 400);
    if (!USERNAME_RE.test(username)) return fail('Username needs 3+ characters: letters, numbers, dot, dash or underscore', 400);
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
    if (!row || !(await verifyPassword(String(body.current || ''), row.password_hash))) {
      return fail('Current password is wrong', 403);
    }
    const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').bind(username, user.id).first();
    if (taken) return fail('That username is already taken', 409);
    await env.DB.prepare('UPDATE users SET name = ?, username = ? WHERE id = ?').bind(name, username, user.id).run();
    return json({ ok: true, user: { ...user, name, username } });
  }

  /* ---------- superadmin ---------- */

  if (path.startsWith('/admin/')) {
    const admin = await requireUser(request, env, 'admin');
    if (!admin) return fail('Superadmin sign-in required', 401);
    // Any console visit nudges waiting entries out — except the sync button,
    // which writes them itself and must not race its own background copy.
    if (path !== '/admin/sync') kickFlush(env, ctx);

    if (path === '/admin/summary' && method === 'GET') {
      const [emps, today, pending, sync, multi] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'employee' AND active = 1").first(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?').bind(localMidnightUtc(env.TIMEZONE)).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE sheet_status = 'pending'").first(),
        kvGet(env, 'sync'),
        env.DB.prepare(
          'SELECT COUNT(*) AS n FROM (SELECT employee_id FROM devices GROUP BY employee_id HAVING COUNT(*) > 1)',
        ).first(),
      ]);
      let report = null;
      let reportError = null;
      try { report = await getReport(env); } catch (err) { reportError = err.message; }
      return json({
        ok: true,
        admin: { id: admin.id, name: admin.name, username: admin.username },
        employees: emps.n, entries_today: today.n, pending: pending.n, sync,
        multi_device: multi.n,
        sites: report ? report.sites.length : null,
        report_fetched_at: report?.fetched_at || null,
        report_error: report?.error || reportError,
        entry_code: env.ENTRY_CODE || 'RKP-45BT2',
      });
    }

    /* Every site in FL Rep, plus how many employees can see each one. */
    if (path === '/admin/sites' && method === 'GET') {
      const report = await getReport(env, { force: url.searchParams.get('refresh') === '1' });
      const { results } = await env.DB.prepare(
        'SELECT site_name, COUNT(*) AS n FROM site_access GROUP BY site_name',
      ).all();
      const counts = new Map(results.map((r) => [normName(r.site_name), r.n]));
      return json({
        ok: true,
        fetched_at: report.fetched_at, error: report.error || null, colours: report.colours,
        sites: report.sites.map((s) => ({
          sl: s.sl, name: s.name, code: s.code, group: s.group, holders: counts.get(normName(s.name)) || 0,
        })),
      });
    }

    if (path === '/admin/employees' && method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT u.id, u.name, u.username, u.phone, u.active,
               (SELECT COUNT(*) FROM site_access a WHERE a.employee_id = u.id) AS sites,
               (SELECT COUNT(*) FROM devices d WHERE d.employee_id = u.id) AS devices,
               (SELECT MAX(d.last_seen) FROM devices d WHERE d.employee_id = u.id) AS last_seen
        FROM users u
        WHERE u.role = 'employee'
        ORDER BY u.active DESC, u.name COLLATE NOCASE
      `).all();
      return json({ ok: true, employees: results });
    }

    if (path === '/admin/employees' && method === 'POST') {
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      if (name.length < 2) return fail('Enter the full name');
      if (!USERNAME_RE.test(username)) return fail('Username needs 3+ characters: letters, numbers, dot, dash or underscore');
      if (String(body.password || '').length < 6) return fail('Password needs at least 6 characters');
      const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exists) return fail(`Username "${username}" is already taken`, 409);
      await env.DB.prepare(
        "INSERT INTO users (username, password_hash, role, name, phone) VALUES (?, ?, 'employee', ?, ?)",
      ).bind(username, await hashPassword(body.password), name, String(body.phone || '').trim() || null).run();
      return json({ ok: true });
    }

    const empMatch = /^\/admin\/employees\/(\d+)$/.exec(path);
    if (empMatch && method === 'PATCH') {
      const id = Number(empMatch[1]);
      const target = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND role = 'employee'").bind(id).first();
      if (!target) return fail('No such employee', 404);
      if (body.password !== undefined) {
        if (String(body.password).length < 6) return fail('Password needs at least 6 characters');
        await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .bind(await hashPassword(body.password), id).run();
      }
      if (body.active !== undefined) {
        await env.DB.prepare('UPDATE users SET active = ? WHERE id = ?').bind(body.active ? 1 : 0, id).run();
      }
      if (body.name !== undefined || body.phone !== undefined) {
        const name = String(body.name ?? '').trim();
        if (body.name !== undefined && name.length < 2) return fail('Enter the full name');
        await env.DB.prepare(
          'UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?',
        ).bind(body.name !== undefined ? name : null, body.phone !== undefined ? String(body.phone).trim() : null, id).run();
      }
      return json({ ok: true });
    }

    /* Every device, newest first, with the accounts sharing a device flagged. */
    if (path === '/admin/devices' && method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT d.employee_id, d.device_id, d.label, d.platform, d.first_seen, d.last_seen, d.logins,
               u.name, u.username, u.active
        FROM devices d JOIN users u ON u.id = d.employee_id
        ORDER BY d.last_seen DESC LIMIT 2000
      `).all();
      // A device id seen under more than one account means a shared phone.
      const perDevice = new Map();
      for (const r of results) perDevice.set(r.device_id, (perDevice.get(r.device_id) || 0) + 1);
      return json({
        ok: true,
        devices: results.map((r) => ({ ...r, shared: perDevice.get(r.device_id) > 1 })),
      });
    }

    /* The devices of one employee. */
    const devMatch = /^\/admin\/devices\/(\d+)$/.exec(path);
    if (devMatch && method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT device_id, label, platform, first_seen, last_seen, logins
        FROM devices WHERE employee_id = ? ORDER BY last_seen DESC
      `).bind(Number(devMatch[1])).all();
      return json({ ok: true, devices: results });
    }

    /* Forget one device. The phone is signed out the next time it calls. */
    if (devMatch && method === 'DELETE') {
      const id = Number(devMatch[1]);
      const deviceId = cleanDeviceId(body.device_id);
      if (!deviceId) return fail('Which device?', 400);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM devices WHERE employee_id = ? AND device_id = ?').bind(id, deviceId),
        env.DB.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').bind(id),
      ]);
      return json({ ok: true, signed_out_all: true });
    }

    /* Sign this employee out everywhere; every existing token stops working. */
    if (/^\/admin\/employees\/(\d+)\/signout$/.test(path) && method === 'POST') {
      const id = Number(/(\d+)/.exec(path)[1]);
      const target = await env.DB.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'employee'")
        .bind(id).first();
      if (!target) return fail('No such employee', 404);
      const had = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE employee_id = ?').bind(id).first();
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM devices WHERE employee_id = ?').bind(id),
      ]);
      return json({ ok: true, name: target.name, devices: had.n });
    }

    /**
     * Delete an employee for good. Their sign-in and site list go; the entries
     * they already filed stay, still showing their name, because those are a
     * record of work that is already in the sheet.
     * employee_id is cleared explicitly rather than relying on ON DELETE SET
     * NULL, so this works whatever the database's foreign-key setting.
     */
    if (empMatch && method === 'DELETE') {
      const id = Number(empMatch[1]);
      const target = await env.DB.prepare(
        "SELECT id, name, username FROM users WHERE id = ? AND role = 'employee'",
      ).bind(id).first();
      if (!target) return fail('No such employee', 404);

      const counts = await env.DB.prepare(`
        SELECT (SELECT COUNT(*) FROM entries WHERE employee_id = ?1) AS entries,
               (SELECT COUNT(*) FROM entries WHERE employee_id = ?1 AND sheet_status = 'pending') AS pending,
               (SELECT COUNT(*) FROM site_access WHERE employee_id = ?1) AS sites
      `).bind(id).first();

      // Anything of theirs still queued goes to the sheet first, so deleting
      // the person can never be what loses an entry.
      if (counts.pending) {
        await flushEntries(env);
        const left = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM entries WHERE employee_id = ? AND sheet_status = 'pending'",
        ).bind(id).first();
        if (left.n && !body.force) {
          return fail(
            `${left.n} of their entries have not reached the sheet yet. Try again in a minute, `
            + 'or use Disable instead so nothing is lost.', 409,
          );
        }
      }

      await env.DB.batch([
        env.DB.prepare('UPDATE entries SET employee_id = NULL WHERE employee_id = ?').bind(id),
        env.DB.prepare('DELETE FROM site_access WHERE employee_id = ?').bind(id),
        // explicit, so it holds whether or not foreign keys are enforced
        env.DB.prepare('DELETE FROM devices WHERE employee_id = ?').bind(id),
        env.DB.prepare("DELETE FROM users WHERE id = ? AND role = 'employee'").bind(id),
      ]);
      return json({
        ok: true,
        name: target.name, username: target.username,
        entries_kept: counts.entries, sites_removed: counts.sites,
      });
    }

    /* The sites one employee can see, matched against the live report. */
    const accessMatch = /^\/admin\/access\/(\d+)$/.exec(path);
    if (accessMatch && method === 'GET') {
      const id = Number(accessMatch[1]);
      const { results } = await env.DB.prepare(
        'SELECT site_name, site_code, assigned_at FROM site_access WHERE employee_id = ? ORDER BY site_name',
      ).bind(id).all();
      const report = await getReport(env);
      const { matched, missing } = matchSites(report, results);
      return json({
        ok: true,
        sites: matched.map((m) => ({
          name: m.site.name, code: m.site.code, group: m.site.group,
          renamed_from: normName(m.stored.site_name) !== normName(m.site.name) ? m.stored.site_name : null,
        })),
        missing,
      });
    }

    /* Replace one employee's site list with exactly the names given. */
    if (accessMatch && method === 'PUT') {
      const id = Number(accessMatch[1]);
      const emp = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND role = 'employee'").bind(id).first();
      if (!emp) return fail('No such employee', 404);
      const wanted = new Map();
      for (const raw of Array.isArray(body.sites) ? body.sites.slice(0, 5000) : []) {
        const name = String(raw || '').trim();
        if (name) wanted.set(normName(name), name);
      }
      const { results: current } = await env.DB.prepare(
        'SELECT site_name FROM site_access WHERE employee_id = ?',
      ).bind(id).all();
      const have = new Map(current.map((r) => [normName(r.site_name), r.site_name]));

      const stmts = [];
      for (const [key, stored] of have) {
        if (!wanted.has(key)) {
          stmts.push(env.DB.prepare('DELETE FROM site_access WHERE employee_id = ? AND site_name = ?').bind(id, stored));
        }
      }
      for (const [key, name] of wanted) {
        if (!have.has(key)) {
          stmts.push(env.DB.prepare(
            'INSERT OR IGNORE INTO site_access (employee_id, site_name, site_code, assigned_by) VALUES (?, ?, ?, ?)',
          ).bind(id, name, siteCode(name), admin.id));
        } else if (have.get(key) !== name) {
          // Same site, name written differently in the sheet now: keep it current.
          stmts.push(env.DB.prepare(
            'UPDATE site_access SET site_name = ?, site_code = ? WHERE employee_id = ? AND site_name = ?',
          ).bind(name, siteCode(name), id, have.get(key)));
        }
      }
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
      const added = [...wanted.keys()].filter((k) => !have.has(k)).length;
      const removed = [...have.keys()].filter((k) => !wanted.has(k)).length;
      return json({ ok: true, added, removed, total: wanted.size });
    }

    /* Who can see one site. Matches renamed sites the same way employees see them. */
    if (path === '/admin/site-access' && method === 'GET') {
      const report = await getReport(env);
      const site = report.sites.find((s) => normName(s.name) === normName(url.searchParams.get('site')));
      if (!site) return fail('That site is not in FL Rep any more', 404);
      const holders = await siteHolders(env, report, site);
      return json({ ok: true, site: site.name, employee_ids: holders.map((h) => h.employee_id) });
    }

    /* Replace who can see one site with exactly the employees given. */
    if (path === '/admin/site-access' && method === 'PUT') {
      const report = await getReport(env);
      const site = report.sites.find((s) => normName(s.name) === normName(body.site));
      if (!site) return fail('That site is not in FL Rep any more', 404);
      const wanted = new Set((Array.isArray(body.employee_ids) ? body.employee_ids : []).map(Number).filter(Boolean));
      const holders = await siteHolders(env, report, site);
      const have = new Set(holders.map((h) => h.employee_id));
      const stmts = [];
      for (const h of holders) {
        if (!wanted.has(h.employee_id)) {
          stmts.push(env.DB.prepare('DELETE FROM site_access WHERE employee_id = ? AND site_name = ?').bind(h.employee_id, h.site_name));
        }
      }
      for (const id of wanted) {
        if (!have.has(id)) {
          stmts.push(env.DB.prepare(`
            INSERT OR IGNORE INTO site_access (employee_id, site_name, site_code, assigned_by)
            SELECT id, ?, ?, ? FROM users WHERE id = ? AND role = 'employee'
          `).bind(site.name, site.code, admin.id, id));
        }
      }
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
      return json({
        ok: true,
        added: [...wanted].filter((id) => !have.has(id)).length,
        removed: [...have].filter((id) => !wanted.has(id)).length,
        total: wanted.size,
      });
    }

    /* Give one site to many employees at once (adds only, never removes). */
    if (path === '/admin/access/grant' && method === 'POST') {
      const name = String(body.site || '').trim();
      if (!name) return fail('Pick a site');
      const ids = (Array.isArray(body.employee_ids) ? body.employee_ids : []).map(Number).filter(Boolean).slice(0, 1000);
      if (!ids.length) return fail('Pick at least one employee');
      const stmts = ids.map((id) => env.DB.prepare(`
        INSERT OR IGNORE INTO site_access (employee_id, site_name, site_code, assigned_by)
        SELECT id, ?, ?, ? FROM users WHERE id = ? AND role = 'employee'
      `).bind(name, siteCode(name), admin.id, id));
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
      return json({ ok: true, granted: ids.length });
    }

    if (path === '/admin/entries' && method === 'GET') {
      const emp = Number(url.searchParams.get('employee_id')) || null;
      const { results } = await env.DB.prepare(`
        SELECT id, kind, site_text, diesel_filled, generator_reading, service_reading,
               entry_stamp, sheet_status, sheet_row, created_at, employee_name
        FROM entries
        WHERE (?1 IS NULL OR employee_id = ?1)
        ORDER BY id DESC LIMIT 300
      `).bind(emp).all();
      return json({ ok: true, entries: results });
    }

    if (path === '/admin/sync' && method === 'POST') {
      let r = await flushEntries(env);
      // A write that is genuinely running (an operator just submitted) finishes
      // in about a second; give it that long before reporting "busy".
      for (let i = 0; r.busy && i < 3; i++) { await sleep(700); r = await flushEntries(env); }
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE sheet_status = 'pending'").first();
      if (r.busy) {
        return json({ ok: true, busy: true, remaining: left.n,
          message: 'A sheet write is already running, or waiting 30 s after an error. Try again shortly.' });
      }
      return json({ ok: true, synced: r.synced, remaining: left.n, error: r.error || null });
    }

    return fail('No such endpoint', 404);
  }

  /* ---------- employee ---------- */

  if (path.startsWith('/emp/')) {
    const emp = await requireUser(request, env, 'employee');
    if (!emp) return fail('Sign in again', 401);
    ctx.waitUntil(touchDevice(env, request, emp.id).catch(() => {}));

    /* Only the sites the superadmin gave this employee, with the sheet's colours. */
    if (path === '/emp/sites' && method === 'GET') {
      kickFlush(env, ctx);
      const { results } = await env.DB.prepare(
        'SELECT site_name, site_code FROM site_access WHERE employee_id = ?',
      ).bind(emp.id).all();
      if (!results.length) return json({ ok: true, columns: REPORT_COLUMNS, sites: [], missing: [], fetched_at: null });
      const report = await getReport(env);
      const { matched, missing } = matchSites(report, results);
      return json({
        ok: true,
        columns: REPORT_COLUMNS,
        fetched_at: report.fetched_at,
        error: report.error || null,
        sites: matched.map(({ site }) => ({ sl: site.sl, name: site.name, group: site.group, cells: site.cells })),
        missing,
      });
    }

    /* The डीज़ल भरना form. Saved first, written to the sheet straight after. */
    if (path === '/emp/entry' && method === 'POST') {
      const kind = body.kind === 'service' ? 'service' : 'filling';
      const site = String(body.site || '').trim().slice(0, 200);
      const diesel = kind === 'service' ? '' : String(body.diesel_filled ?? '').trim();
      const gen = kind === 'service' ? '' : String(body.generator_reading ?? '').trim();
      const service = kind === 'service' ? String(body.service_reading ?? '').trim() : null;
      const NUM = /^-?\d+(\.\d+)?$/;
      if (!site) return fail('साइट का नाम लिखें');
      if (kind === 'service') {
        if (!service) return fail('सर्विस के बाद जनरेटर की रीडिंग लिखें');
        if (!NUM.test(service)) return fail('रीडिंग में सिर्फ़ नंबर लिखें');
      } else {
        if (!diesel) return fail('डीज़ल भरवाया लिखें');
        if (!gen) return fail('जनरेटर की रीडिंग लिखें');
        if (!NUM.test(diesel) || !NUM.test(gen)) return fail('रीडिंग में सिर्फ़ नंबर लिखें');
      }

      if (body.client_uuid) {
        const dupe = await env.DB.prepare('SELECT id, sheet_status FROM entries WHERE client_uuid = ?')
          .bind(String(body.client_uuid)).first();
        if (dupe) return json({ ok: true, duplicate: true, id: dupe.id, sheet: dupe.sheet_status });
      }

      // An entry made offline keeps the time it was made, within reason.
      const now = Date.now();
      const taken = Number(body.taken_at);
      const when = body.queued && taken > now - 7 * 864e5 && taken < now + 5 * 60e3 ? new Date(taken) : new Date(now);

      const row = await env.DB.prepare(`
        INSERT INTO entries
          (employee_id, employee_name, kind, site_text, diesel_filled, generator_reading,
           service_reading, entry_stamp, client_uuid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).bind(emp.id, emp.name, kind, site, diesel, gen, service, stampAt(when, env.TIMEZONE),
              body.client_uuid ? String(body.client_uuid) : null).first();

      const r = await flushEntries(env);
      if (r.busy) kickFlush(env, ctx, 1500); // someone else is writing; make sure ours is not left behind
      const mine = await env.DB.prepare('SELECT sheet_status FROM entries WHERE id = ?').bind(row.id).first();
      return json({ ok: true, id: row.id, sheet: mine.sheet_status });
    }

    if (path === '/emp/entries' && method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT id, kind, site_text, diesel_filled, generator_reading, service_reading,
               entry_stamp, sheet_status
        FROM entries WHERE employee_id = ? ORDER BY id DESC LIMIT 50
      `).bind(emp.id).all();
      return json({ ok: true, entries: results });
    }

    return fail('No such endpoint', 404);
  }

  return fail('No such endpoint', 404);
}

/* Exposed for tests. */
export const _internal = { parseReport, matchSites, RULES, stampAt, siteCode, asSheetText, localMidnightUtc };
