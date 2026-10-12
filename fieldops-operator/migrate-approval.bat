@echo off
rem Run ONCE, BEFORE deploying, on a database created before the diesel %% box
rem and phone approval were added. Use this if "--file=./migrate-approval.sql"
rem is refused. Run from the project folder.
rem Phones already signed in stay approved; nobody is locked out.

call npx wrangler d1 execute fieldops-operator --remote --command="ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'"
call npx wrangler d1 execute fieldops-operator --remote --command="ALTER TABLE devices ADD COLUMN decided_at TEXT"
call npx wrangler d1 execute fieldops-operator --remote --command="CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status)"
call npx wrangler d1 execute fieldops-operator --remote --command="ALTER TABLE entries ADD COLUMN diesel_pct TEXT"

echo.
echo Migration done. Now deploy.
pause
