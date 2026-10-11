-- Run ONCE on a database created before the सर्विस screen was added.
-- Not needed for a fresh install — schema.sql already has these.
--
-- Adds the two columns a service entry needs. Existing entries are all
-- diesel fillings, which is what the default records.
-- Safe to run with live data; nothing is rewritten.
-- If --file is refused, run migrate-service-screen.bat instead.

ALTER TABLE entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'filling';

ALTER TABLE entries ADD COLUMN service_reading TEXT;
