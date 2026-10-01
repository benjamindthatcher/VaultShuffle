-- Standalone elapsed-clock regression for app.resolve_session.
--
-- Run this file with psql/direct session execution. It deliberately sends the
-- INSERT, pg_sleep, and resolver assertion as separate statements: a
-- management API that wraps the entire file as one query can keep
-- statement_timestamp() fixed at query start and cannot exercise this check.
-- The transaction is rolled back and no existing rows are modified.

begin;
grant vault_app to current_user with set true;

create temp table m1_session_clock_fixture (
  account_id integer not null,
  token_digest bytea not null
) on commit drop;

with inserted_account as (
  insert into app.accounts (public_id, account_kind, display_name)
  values (gen_random_uuid(), 'manual', 'M1 session clock fixture')
  returning id
), input as materialized (
  select id as account_id,
         decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex') as token_digest
    from inserted_account
), inserted_session as (
  insert into app.sessions (account_id, token_digest, session_kind, expires_at)
  select account_id, token_digest, 'manual', statement_timestamp() + interval '1 second'
    from input
  returning account_id, token_digest
)
insert into m1_session_clock_fixture (account_id, token_digest)
select account_id, token_digest from inserted_session;

select set_config(
  'm1.session_clock_digest',
  (select encode(token_digest, 'hex') from m1_session_clock_fixture),
  true
);

set role vault_app;

-- This is a separate protocol statement from the INSERT above.
select pg_sleep(1.1);

do $assert$
declare
  v_count bigint;
begin
  select count(*) into v_count
    from app.resolve_session(
      decode(current_setting('m1.session_clock_digest'), 'hex'),
      'manual'
    );
  if v_count <> 0 then
    raise exception 'session resolver used transaction-start time after expiry';
  end if;
end
$assert$;

reset role;
rollback;
select 'm1 elapsed session-clock assertion passed' as result;
