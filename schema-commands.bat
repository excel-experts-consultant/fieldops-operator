@echo off
rem Loads schema.sql one statement at a time. Use this if
rem   npx wrangler d1 execute fieldops-operator --remote --file=./schema.sql
rem fails with an authentication error. Run from the project folder.

call npx wrangler d1 execute fieldops-operator --remote --command="DROP TABLE IF EXISTS locks"
call npx wrangler d1 execute fieldops-operator --remote --command="DROP TABLE IF EXISTS kv"
call npx wrangler d1 execute fieldops-operator --remote --command="DROP TABLE IF EXISTS entries"
call npx wrangler d1 execute fieldops-operator --remote --command="DROP TABLE IF EXISTS site_access"
call npx wrangler d1 execute fieldops-operator --remote --command="DROP TABLE IF EXISTS users"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE TABLE users ( id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','employee')), name TEXT NOT NULL, phone TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')) )"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE INDEX idx_users_role ON users(role, active)"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE TABLE site_access ( employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, site_name TEXT NOT NULL, site_code TEXT, assigned_by INTEGER REFERENCES users(id), assigned_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (employee_id, site_name) )"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE INDEX idx_access_site ON site_access(site_name)"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE INDEX idx_access_code ON site_access(site_code)"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE TABLE entries ( id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES users(id), site_text TEXT NOT NULL, diesel_filled TEXT NOT NULL, generator_reading TEXT NOT NULL, entry_stamp TEXT NOT NULL, client_uuid TEXT UNIQUE, sheet_status TEXT NOT NULL DEFAULT 'pending' CHECK (sheet_status IN ('pending','synced')), sheet_row TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')) )"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE INDEX idx_entries_sync ON entries(sheet_status, id)"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE INDEX idx_entries_emp ON entries(employee_id, id)"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE TABLE kv ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL )"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE TABLE locks ( name TEXT PRIMARY KEY, until INTEGER NOT NULL )"

echo.
echo Schema loaded.
pause
