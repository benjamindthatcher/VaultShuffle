-- M4: bounded manual-session sliding renewal.
--
-- The app runtime never receives direct privileges on app.sessions. This
-- narrowly-scoped definer function receives the HMAC digest already verified
-- by app.resolve_session and that resolver's session ID, then returns only the
-- effective expiry. The database statement clock is authoritative.

create function app.touch_manual_session(
  p_token_digest bytea,
  p_session_id bigint
)
returns table (expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  return query
  update app.sessions as s
     set last_seen_at = statement_timestamp(),
         expires_at = statement_timestamp() + interval '365 days'
    from app.accounts as a
   where p_token_digest is not null
     and octet_length(p_token_digest) = 32
     and p_session_id > 0
     and s.id = p_session_id
     and s.token_digest = p_token_digest
     and s.session_kind = 'manual'
     and s.account_id = a.id
     and a.account_kind = 'manual'
     and a.lifecycle_status = 'active'
     and s.revoked_at is null
     and s.expires_at > statement_timestamp()
     and (s.last_seen_at is null or s.last_seen_at <= statement_timestamp() - interval '1 hour')
  returning s.expires_at;

  if found then
    return;
  end if;

  -- A valid session inside the hourly gate is still a successful lookup. Do
  -- not update it, but return its database-held expiry to the repository.
  return query
  select s.expires_at
    from app.sessions as s
    join app.accounts as a on a.id = s.account_id
   where p_token_digest is not null
     and octet_length(p_token_digest) = 32
     and p_session_id > 0
     and s.id = p_session_id
     and s.token_digest = p_token_digest
     and s.session_kind = 'manual'
     and a.account_kind = 'manual'
     and a.lifecycle_status = 'active'
     and s.revoked_at is null
     and s.expires_at > statement_timestamp();
end
$$;

-- The session resolver and this renewal boundary must have the same migration
-- owner. A different owner could silently alter the SECURITY DEFINER trust
-- boundary when a target replays this additive migration.
do $$
declare
  resolver_owner oid;
  touch_owner oid;
begin
  select proowner into resolver_owner
    from pg_catalog.pg_proc
   where oid = 'app.resolve_session(bytea,text)'::regprocedure;
  select proowner into touch_owner
    from pg_catalog.pg_proc
   where oid = 'app.touch_manual_session(bytea,bigint)'::regprocedure;

  if resolver_owner is null or touch_owner is null or resolver_owner <> touch_owner then
    raise exception 'app.touch_manual_session must share app.resolve_session ownership';
  end if;
end
$$;

revoke all on function app.touch_manual_session(bytea, bigint) from public, vault_app, vault_worker;
grant execute on function app.touch_manual_session(bytea, bigint) to vault_app;
