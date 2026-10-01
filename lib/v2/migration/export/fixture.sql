-- Synthetic source fixture for the M3-A export integration test.
--
-- Every row here is invented. Nothing in this file comes from, resembles, or is
-- derived from VaultShuffle production data, and the exporter test never
-- connects to anything but the local disposable cluster this builds.
--
-- Build both fixture databases (the test never creates or drops one itself):
--
--   export PGHOST=/tmp/vaultshuffle-pg17-socket PGPORT=55432 PGUSER=vault_local_admin
--   PG=/tmp/vaultshuffle-pg17/bin
--   $PG/createdb vaultshuffle_m3_export_a
--   $PG/createdb vaultshuffle_m3_export_target
--   $PG/psql -v ON_ERROR_STOP=1 -d vaultshuffle_m3_export_a \
--     -f lib/v2/migration/export/fixture.sql
--   $PG/psql -v ON_ERROR_STOP=1 -d vaultshuffle_m3_export_target \
--     -f lib/v2/migration/export/fixture-target.sql
--
-- The socket directory, port, role and database names are not baked in: the
-- integration test reads them from VAULTSHUFFLE_M3_EXPORT_PGHOST, _PGPORT,
-- _PGUSER, _PSQL, _SOURCE_DB and _TARGET_DB, and this file names no database
-- literally, so a disposable cluster can be stood up anywhere under /tmp.
--
-- Re-running this file rebuilds the source fixture from scratch.

-- The loading session pins its own formatting. The ALTER DATABASE statements at
-- the foot of this file deliberately leave the *default* formatting wrong, and a
-- second run must not start parsing its own date literals under them. `SET` is
-- session-scoped and beats the database default.
SET DateStyle = 'ISO, YMD';
SET TimeZone = 'UTC';
SET IntervalStyle = 'iso_8601';

DROP VIEW  IF EXISTS public.exp_view;
DROP TABLE IF EXISTS public.exp_bulk;
DROP TABLE IF EXISTS public.exp_concurrent;
DROP TABLE IF EXISTS public.exp_scalars;
DROP TABLE IF EXISTS public.exp_drift;

-- A relation large enough that holding it in memory would show up, and large
-- enough to make the COPY stream cross the write stream's high-water mark many
-- times over. ~12.7 MB across 60,000 rows.
CREATE TABLE public.exp_bulk (
  id bigint PRIMARY KEY,
  payload text NOT NULL
);
INSERT INTO public.exp_bulk (id, payload)
SELECT g, repeat('x', 200) || g::text FROM generate_series(1, 60000) AS g;

-- The relation the concurrency test writes to while the snapshot is open.
CREATE TABLE public.exp_concurrent (
  id bigint PRIMARY KEY,
  note text NOT NULL,
  written timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.exp_concurrent (id, note)
SELECT g, 'before-export-' || g FROM generate_series(1, 100) AS g;

-- One row per value-fidelity hazard. Insertion order is load-bearing: the
-- exporter pins synchronize_seqscans off so a sequential scan starts at block 0,
-- which makes heap order the output order, and the all-null row must be first so
-- the test can assert the first line of the file carries \N.
CREATE TABLE public.exp_scalars (
  id bigint PRIMARY KEY,
  label text,
  exact_numeric numeric(38,10),
  rounded_numeric numeric(10,1),
  approx_double double precision,
  approx_real real,
  civil_date date,
  instant timestamptz,
  naive_stamp timestamp,
  span interval,
  flag boolean,
  raw bytea,
  doc jsonb,
  ident uuid
);

-- 1: everything null. 2: everything zero or empty. The pair is the whole point:
-- null, empty string and zero have to survive as three different things.
INSERT INTO public.exp_scalars (id) VALUES (1);
INSERT INTO public.exp_scalars
  (id, label, exact_numeric, rounded_numeric, approx_double, approx_real,
   civil_date, instant, naive_stamp, span, flag, raw, doc, ident)
VALUES
  (2, '', 0, 0, 0, 0, DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 00:00:00+00',
   TIMESTAMP '2026-01-01 00:00:00', INTERVAL 'PT0S', false, '\x'::bytea, '{}'::jsonb,
   '00000000-0000-0000-0000-000000000000'::uuid),
  (3, 'zero-vs-null', 0, 0, 0, 0, DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 00:00:00+00',
   TIMESTAMP '2026-01-01 00:00:00', INTERVAL 'PT0S', false, '\x00'::bytea, '{"a": null}'::jsonb,
   '11111111-1111-1111-1111-111111111111'::uuid);

-- Signed 64-bit bounds, and a numeric wider than a double can hold. 2^53+1 is
-- the smallest integer a JavaScript number cannot represent, so any value that
-- passes through a float loses it.
INSERT INTO public.exp_scalars (id, label, exact_numeric) VALUES
  (-9223372036854775808, 'bigint-min',   9007199254740993),
  ( 9223372036854775807, 'bigint-max',  -9007199254740993),
  (4, 'numeric-wide', 1234567890123456789012345678.0123456789),
  (5, 'numeric-neg',  -0.0000000001);

INSERT INTO public.exp_scalars (id, label, approx_double, approx_real) VALUES
  (6, 'float-roundtrip', 0.1,                 0.1),
  (7, 'float-precise',   1.2345678901234567,  1.2345679),
  (8, 'float-large',     1e308,               1e38);

-- Civil dates. A date has no zone, so none of these may shift or gain a time,
-- including across either hemisphere's clock change and across a leap day.
INSERT INTO public.exp_scalars (id, label, civil_date) VALUES
  (10, 'leap-day',      DATE '2024-02-29'),
  (11, 'uk-dst-start',  DATE '2026-03-29'),
  (12, 'uk-dst-end',    DATE '2026-10-25'),
  (13, 'us-dst-start',  DATE '2026-03-08'),
  (14, 'year-boundary', DATE '2025-12-31');

-- Instants. The DST ones are written as a local wall clock in the zone where the
-- clocks move, so the stored value is only right if the zone was applied on the
-- way in. They must come back as UTC whatever the server's own TimeZone is.
INSERT INTO public.exp_scalars (id, label, instant) VALUES
  (20, 'uk-dst-spring-forward', TIMESTAMPTZ '2026-03-29 00:59:59 Europe/London'),
  (21, 'uk-dst-after',          TIMESTAMPTZ '2026-03-29 02:00:00 Europe/London'),
  (22, 'uk-dst-fall-back',      TIMESTAMPTZ '2026-10-25 01:59:59+00'),
  (23, 'us-eastern-local',      TIMESTAMPTZ '2026-03-08 01:59:59 America/New_York'),
  (24, 'us-eastern-after',      TIMESTAMPTZ '2026-03-08 03:00:00 America/New_York'),
  (25, 'sub-second',            TIMESTAMPTZ '2026-07-04 12:34:56.789012+00'),
  (26, 'far-future',            TIMESTAMPTZ '2999-12-31 23:59:59+00'),
  (27, 'pre-epoch',             TIMESTAMPTZ '1969-07-20 20:17:40+00');

-- Text that has to survive COPY's text-format escaping, including a literal
-- two-character backslash-N that must not decode back to a null.
INSERT INTO public.exp_scalars (id, label) VALUES
  (30, E'tab\there'),
  (31, E'newline\nhere'),
  (32, E'backslash\\here'),
  (33, E'carriage\rreturn'),
  (34, 'unicode: café 🎮 ждать'),
  (35, '\N literal-looking'),
  (36, '   leading and trailing   ');

-- A view, to prove a non-table relkind exports and that relkind drift is caught.
-- Exactly one row (id 1) has a null label, so this is one row shorter.
CREATE VIEW public.exp_view AS
  SELECT id, label FROM public.exp_scalars WHERE label IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Hostile database defaults.
--
-- These are the point of the fixture, not an accident. Every one is a setting
-- the exporter pins per session, and leaving the database default wrong is what
-- stops the value-fidelity tests passing vacuously. If the exporter ever stopped
-- applying REQUIRED_SESSION_SETTINGS, instants would come back in New York local
-- time, dates as 29/03/2026, intervals as "@ 0", bytea in escape form and
-- doubles rounded to six significant digits - and the assertions would fail.
--
-- They apply at connection time, so they do not affect this session.
--
-- `ALTER DATABASE` takes an identifier, not an expression, so the name is
-- interpolated from `current_database()`. Writing it literally would tie the
-- fixture to one database name, and the disposable cluster this runs against is
-- recreated under a fresh name each time.
-- ---------------------------------------------------------------------------
DO $fixture_defaults$
DECLARE
  db text := current_database();
  setting text;
BEGIN
  FOREACH setting IN ARRAY ARRAY[
    'TimeZone = ''America/New_York''',
    'DateStyle = ''SQL, DMY''',
    'IntervalStyle = ''postgres_verbose''',
    'bytea_output = ''escape''',
    'extra_float_digits = -3',
    'synchronize_seqscans = ''on'''
  ]
  LOOP
    EXECUTE format('ALTER DATABASE %I SET %s', db, setting);
  END LOOP;
END
$fixture_defaults$;
