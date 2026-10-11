-- Run ONCE on a database created before device tracking was added.
-- Not needed for a fresh install — schema.sql already has these.
--
-- Adds the per-device sign-in log and the counter behind "Sign out all devices".
-- Safe to run with live data; nothing existing is changed.
-- If --file is refused, run migrate-devices.bat instead.

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS devices (
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  label       TEXT,
  platform    TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  logins      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (employee_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_emp ON devices(employee_id, last_seen);
