-- The migration-destination half of the M3-A export fixture.
--
-- The exporter refuses to run against a database carrying a schema its profile
-- declares must be absent, which is the guard that stops a mistyped connection
-- exporting the v2 target back over itself. This database exists only to prove
-- that guard fires, so all it needs is one of those schemas and something in it.
--
-- Build it with the commands in the header of fixture.sql. Run this file only
-- against vaultshuffle_m3_export_target: creating schema `app` in the *source*
-- fixture would make the source fail its own identity check.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.library_games (
  id bigint PRIMARY KEY,
  title text
);
