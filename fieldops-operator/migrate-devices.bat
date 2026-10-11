@echo off
rem Run ONCE on a database created before device tracking was added.
rem Use this if "--file=./migrate-devices.sql" is refused.
rem Run from the project folder.

call npx wrangler d1 execute fieldops-operator --remote --command="ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE TABLE IF NOT EXISTS devices ( employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT NOT NULL, label TEXT, platform TEXT, first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')), logins INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (employee_id, device_id) )"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE INDEX IF NOT EXISTS idx_devices_emp ON devices(employee_id, last_seen)"

echo.
echo Migration done.
pause
