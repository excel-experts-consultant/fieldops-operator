-- Run ONCE on a database created before employee deletion was added.
-- Not needed for a fresh install — schema.sql already has this.
--
-- Why: entries used to get the employee's name by joining the users table, so
-- deleting an employee would either be refused or would lose their entries.
-- This copies the name onto each entry and lets employee_id go empty instead.
--
-- Safe to run with live data: every existing entry keeps its name.
-- If --file is refused, run migrate-employee-delete.bat instead.

CREATE TABLE entries_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  employee_name     TEXT NOT NULL,
  site_text         TEXT NOT NULL,
  diesel_filled     TEXT NOT NULL,
  generator_reading TEXT NOT NULL,
  entry_stamp       TEXT NOT NULL,
  client_uuid       TEXT UNIQUE,
  sheet_status      TEXT NOT NULL DEFAULT 'pending' CHECK (sheet_status IN ('pending','synced')),
  sheet_row         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO entries_new
  (id, employee_id, employee_name, site_text, diesel_filled, generator_reading,
   entry_stamp, client_uuid, sheet_status, sheet_row, created_at)
SELECT e.id, e.employee_id, COALESCE(u.name, 'Deleted employee'), e.site_text,
       e.diesel_filled, e.generator_reading, e.entry_stamp, e.client_uuid,
       e.sheet_status, e.sheet_row, e.created_at
FROM entries e LEFT JOIN users u ON u.id = e.employee_id;

DROP TABLE entries;

ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX idx_entries_sync ON entries(sheet_status, id);

CREATE INDEX idx_entries_emp ON entries(employee_id, id);
