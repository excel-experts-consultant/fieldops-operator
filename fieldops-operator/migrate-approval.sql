-- Run ONCE on a database created before the डीज़ल% box and phone approval.
--   npx wrangler d1 execute fieldops-operator --remote --file=./migrate-approval.sql
-- If --file is refused, double-click migrate-approval.bat instead.
--
-- Every phone already signed in is kept as approved, so nobody is locked out
-- by the update. Only phones added from now on wait for approval.

ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE devices ADD COLUMN decided_at TEXT;
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
ALTER TABLE entries ADD COLUMN diesel_pct TEXT;
