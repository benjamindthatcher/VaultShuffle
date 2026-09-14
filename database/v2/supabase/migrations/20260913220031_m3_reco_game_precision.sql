-- M3 recommendation evidence precision correction. PREPARED LOCALLY, NOT APPLIED.
--
-- The real snapshot proves all three float8 values on
-- public.game_preference_globals need more fractional precision than
-- numeric(30,12) can retain exactly. This changes only their destination type
-- modifiers. NOT NULL, ordering/nonnegative checks, primary/FK constraints,
-- indexes, RLS policies, grants and retention registration remain attached.

begin;

do $$
declare
  v_column text;
  v_type text;
  v_check text;
begin
  foreach v_column in array array['positive', 'total', 'total_hours'] loop
    select format_type(att.atttypid, att.atttypmod)
      into v_type
    from pg_attribute att
    join pg_class rel on rel.oid = att.attrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'reco'
      and rel.relname = 'game_preference_globals'
      and att.attname = v_column
      and att.attnum > 0
      and not att.attisdropped;

    if v_type is distinct from 'numeric(30,12)' then
      raise exception 'drift: reco.game_preference_globals.% type is %, expected numeric(30,12)', v_column, v_type;
    end if;
  end loop;

  for v_column, v_check in
    select con.conname, pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'reco'
      and rel.relname = 'game_preference_globals'
      and con.conname in (
        'game_preference_globals_positive_check',
        'game_preference_globals_check',
        'game_preference_globals_total_hours_check'
      )
  loop
    if (v_column = 'game_preference_globals_positive_check' and v_check is distinct from 'CHECK ((positive >= (0)::numeric))')
      or (v_column = 'game_preference_globals_check' and v_check is distinct from 'CHECK ((total >= positive))')
      or (v_column = 'game_preference_globals_total_hours_check' and v_check is distinct from 'CHECK ((total_hours >= (0)::numeric))')
    then
      raise exception 'drift: % is %, expected the M3 counter check', v_column, v_check;
    end if;
  end loop;

  if (select count(*) from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'reco'
        and rel.relname = 'game_preference_globals'
        and con.conname in (
          'game_preference_globals_positive_check',
          'game_preference_globals_check',
          'game_preference_globals_total_hours_check'
        )) <> 3
  then
    raise exception 'drift: reco.game_preference_globals counter checks are incomplete';
  end if;
end $$;

alter table reco.game_preference_globals
  alter column positive type numeric using positive::numeric,
  alter column total type numeric using total::numeric,
  alter column total_hours type numeric using total_hours::numeric,
  add constraint game_preference_globals_finite_check check (
    positive::text not in ('NaN', 'Infinity', '-Infinity')
    and total::text not in ('NaN', 'Infinity', '-Infinity')
    and total_hours::text not in ('NaN', 'Infinity', '-Infinity')
  );

comment on column reco.game_preference_globals.positive is
  'Exact finite legacy float8 text interpreted as an unconstrained nonnegative numeric; no rounding or JavaScript number conversion.';
comment on column reco.game_preference_globals.total is
  'Exact finite legacy float8 text interpreted as an unconstrained numeric not less than positive; no rounding or JavaScript number conversion.';
comment on column reco.game_preference_globals.total_hours is
  'Exact finite legacy float8 text interpreted as an unconstrained nonnegative numeric; no rounding, clamping, unit conversion or JavaScript number conversion.';

commit;
