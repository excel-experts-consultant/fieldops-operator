@echo off
rem Run ONCE on a database created before the service screen was added.
rem Use this if "--file=./migrate-service-screen.sql" is refused.
rem Run from the project folder.

call npx wrangler d1 execute fieldops-operator --remote --command="ALTER TABLE entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'filling'"
call npx wrangler d1 execute fieldops-operator --remote --command="ALTER TABLE entries ADD COLUMN service_reading TEXT"

echo.
echo Migration done.
pause
