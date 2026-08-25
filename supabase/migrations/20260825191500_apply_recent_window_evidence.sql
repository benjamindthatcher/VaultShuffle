-- Record Steam's recently-played list as window evidence.
--
-- Steam tells us which games were played in roughly the last fortnight, but not
-- when. That is weaker than watching playtime rise, so it is only written where
-- it actually adds something: where we hold no evidence at all, or where our
-- evidence is already older than the window Steam is describing.
--
-- last_observed_played_at is deliberately NOT set. We do not know the day, and
-- writing one would be inventing precision. describeRecency reads
-- recency_evidence_at for this source and reports "Played recently".
--
-- Absence from the list is not evidence of anything, so games that are not in it
-- are left completely alone.

create or replace function public.apply_steam_recent_window(
  p_user_id uuid,
  p_appids bigint[]
) returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_updated integer;
begin
  if p_user_id is null then
    raise exception 'INVALID_RECENCY_USER';
  end if;
  if p_appids is null or cardinality(p_appids) = 0 then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  update public.user_games
  set recency_source = 'steam_recent_window',
      recency_evidence_at = now(),
      updated_at = now()
  where user_id = p_user_id
    and ownership = 'Owned'
    and catalog_steam_appid = any(p_appids)
    and (
      -- Nothing known yet, so anything is an improvement.
      last_observed_played_at is null
      -- Or what we know is older than the fortnight Steam is talking about, so
      -- the window genuinely supersedes it.
      or last_observed_played_at < now() - interval '14 days'
    );

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$function$;

revoke all on function public.apply_steam_recent_window(uuid, bigint[]) from public, anon, authenticated;
grant execute on function public.apply_steam_recent_window(uuid, bigint[]) to service_role;
