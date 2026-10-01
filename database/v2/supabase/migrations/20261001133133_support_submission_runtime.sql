-- Support writes remain private and work for guests as well as verified sessions.
-- Account IDs are derived only from the server-verified transaction principal.
begin;

create index contact_messages_recent_dedupe_idx on support.contact_messages(dedupe_hash, created_at desc)
  where dedupe_hash is not null;
create index feedback_submissions_recent_dedupe_idx on support.feedback_submissions(dedupe_hash, created_at desc)
  where dedupe_hash is not null;

create function support.submit_contact(p_payload jsonb)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  v_account_id integer := app.current_account_id();
  v_public_id uuid;
  v_hash text := p_payload->>'dedupe_hash';
  v_now timestamptz;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_hash is null
    or v_hash !~ '^[0-9a-f]{64}$' or (p_payload->>'enquiry_type')::integer not between 0 and 5
    or p_payload->>'email' is null or position('@' in p_payload->>'email') < 2 then
    raise exception using errcode='22023', message='support_submission_invalid';
  end if;
  if v_account_id is not null then
    select public_id into v_public_id from app.accounts where id=v_account_id and lifecycle_status='active';
    if not found then raise exception using errcode='28000',message='account_required'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('contact:' || v_hash, 0));
  v_now := clock_timestamp();
  if exists(select 1 from support.contact_messages where dedupe_hash=v_hash and created_at>=v_now-interval '10 minutes') then
    return false;
  end if;
  insert into support.contact_messages(source_record_id,source_account_public_id,account_id,
    enquiry_type,email,subject,message,dedupe_hash,status_code,created_at,updated_at)
  values(gen_random_uuid(),v_public_id,v_account_id,(p_payload->>'enquiry_type')::smallint,
    p_payload->>'email',p_payload->>'subject',p_payload->>'message',v_hash,0,v_now,v_now);
  return true;
end $$;

create function support.submit_feedback(p_payload jsonb)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  v_account_id integer := app.current_account_id();
  v_public_id uuid;
  v_hash text := p_payload->>'dedupe_hash';
  v_consent boolean := (p_payload->>'contact_allowed')::boolean;
  v_now timestamptz;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_hash is null
    or v_hash !~ '^[0-9a-f]{64}$' or (p_payload->>'feedback_type')::integer not in(0,1)
    or v_consent is null then
    raise exception using errcode='22023',message='support_submission_invalid';
  end if;
  if v_account_id is not null then
    select public_id into v_public_id from app.accounts where id=v_account_id and lifecycle_status='active';
    if not found then raise exception using errcode='28000',message='account_required'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('feedback:' || v_hash, 0));
  v_now := clock_timestamp();
  if exists(select 1 from support.feedback_submissions where dedupe_hash=v_hash and created_at>=v_now-interval '5 minutes') then
    return false;
  end if;
  insert into support.feedback_submissions(source_record_id,source_account_public_id,account_id,
    feedback_type,message,contact_allowed,contact_email,route,app_area,client_context,
    dedupe_hash,status_code,created_at,updated_at)
  values(gen_random_uuid(),v_public_id,v_account_id,(p_payload->>'feedback_type')::smallint,
    p_payload->>'message',v_consent,case when v_consent then nullif(p_payload->>'contact_email','') end,
    nullif(p_payload->>'route',''),nullif(p_payload->>'app_area',''),
    coalesce(nullif(p_payload->'client_context','null'::jsonb),'{}'::jsonb),v_hash,0,v_now,v_now);
  return true;
end $$;

revoke all on function support.submit_contact(jsonb), support.submit_feedback(jsonb) from public, vault_worker;
-- Browser roles exist in hosted Supabase but not in every disposable PG fixture.
do $$ declare v_role text; begin
  foreach v_role in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=v_role) then
      execute format('revoke all on function support.submit_contact(jsonb), support.submit_feedback(jsonb) from %I',v_role);
    end if;
  end loop;
end $$;
grant usage on schema support to vault_app;
grant execute on function support.submit_contact(jsonb), support.submit_feedback(jsonb) to vault_app;
commit;
