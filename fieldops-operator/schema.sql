-- FieldOps Operator schema (Cloudflare D1 / SQLite)
-- Run once on a fresh database:
--   npx wrangler d1 execute fieldops-operator --remote --file=./schema.sql
-- If --file is refused, paste each CREATE statement with --command instead.

DROP TABLE IF EXISTS locks;
DROP TABLE IF EXISTS kv;
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS site_access;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,          -- always lowercase
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','employee')),  -- admin = superadmin here
  name          TEXT NOT NULL,
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  -- Bumped by "Sign out all devices"; a token carrying an older number is refused.
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_role ON users(role, active);

-- Which FL Rep sites each employee may see. Sites live in the sheet, not here,
-- so a row is keyed by the site's name as it appears in FL Rep column B.
-- site_code is the part before the first "_" (A01, ZF4 …) and lets an
-- allocation survive the site being renamed in the sheet.
CREATE TABLE site_access (
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_name   TEXT NOT NULL,
  site_code   TEXT,
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, site_name)
);
CREATE INDEX idx_access_site ON site_access(site_name);
CREATE INDEX idx_access_code ON site_access(site_code);

-- One row per phone (or browser) an account has signed in on. The device id is
-- made once by the app and kept in its own storage, so reinstalling the app or
-- clearing its data counts as a new device.
CREATE TABLE devices (
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  label       TEXT,                 -- e.g. "Android 13 · SM-A135F"
  platform    TEXT,                 -- 'android' | 'web'
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  logins      INTEGER NOT NULL DEFAULT 1,
  -- An account's first phone is approved by itself. Any phone after that
  -- waits here as 'pending' until the superadmin approves or rejects it,
  -- and cannot be used until then.
  status      TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','pending','rejected')),
  decided_at  TEXT,
  PRIMARY KEY (employee_id, device_id)
);
CREATE INDEX idx_devices_emp ON devices(employee_id, last_seen);
CREATE INDEX idx_devices_status ON devices(status);

-- Every डीज़ल भरना entry. D1 is the source of truth; the sheet is written
-- from here in batches, so a busy minute or a Google hiccup never loses one.
CREATE TABLE entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The name is copied in at submit time, so an entry (and column K of the
  -- sheet) still says who filed it after that employee is deleted.
  employee_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  employee_name     TEXT NOT NULL,
  -- 'filling' = the डीज़ल भरना screen, 'service' = the सर्विस screen.
  kind              TEXT NOT NULL DEFAULT 'filling' CHECK (kind IN ('filling','service')),
  site_text         TEXT NOT NULL,
  diesel_filled     TEXT NOT NULL,    -- column D   (filling only, '' on a service entry)
  generator_reading TEXT NOT NULL,    -- column F   (filling only, '' on a service entry)
  diesel_pct        TEXT,             -- column G   डीज़ल% (filling only; blank from older apps)
  service_reading   TEXT,             -- column J   (service only)
  entry_stamp       TEXT NOT NULL,    -- column A, e.g. "09 OCT 26 19:02:00"
  client_uuid       TEXT UNIQUE,      -- offline-safe idempotency key from the phone
  sheet_status      TEXT NOT NULL DEFAULT 'pending' CHECK (sheet_status IN ('pending','synced')),
  sheet_row         TEXT,             -- e.g. "TNK FD!A412" once written
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_entries_sync ON entries(sheet_status, id);
CREATE INDEX idx_entries_emp ON entries(employee_id, id);

-- Small shared values: the cached FL Rep snapshot ("flrep") and the result
-- of the last sheet write ("sync"), kept as one row so an outage costs nothing.
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Short leases so only one request at a time talks to Google for a given job.
CREATE TABLE locks (
  name  TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
