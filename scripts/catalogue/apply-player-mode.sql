-- One primary way each game is played, for the "How you play" global filter.
--
-- Steam's categories list every mode a game supports, so a mostly-multiplayer
-- game with a token campaign appeared under Single-player too. This stores one
-- verdict per game, weighted by community tag votes:
--
-- - Specific tags decide: Singleplayer; Co-op / Online Co-Op / Local Co-Op /
--   Co-op Campaign; PvP / Competitive / Team-Based / Battle Royale / MMO.
-- - Generic tags (Multiplayer, Local Multiplayer, Split Screen...) only
--   corroborate, split between co-op and PvP in proportion to the specific
--   evidence. That keeps Counter-Strike 2's 30k "Co-op" votes from beating its
--   PvP votes, and lets Terraria's "Multiplayer" votes count as co-op.
-- - No mode tags at all: fall back to categories. No tags: null.
--
-- Safe to re-run.

create or replace function public.player_mode_from_signals(tags jsonb, categories text[])
returns text language sql immutable as $$
  with v as (
    select
      coalesce((tags->>'Singleplayer')::numeric, 0) as single,
      greatest(coalesce((tags->>'Co-op')::numeric,0), coalesce((tags->>'Online Co-Op')::numeric,0),
               coalesce((tags->>'Local Co-Op')::numeric,0), coalesce((tags->>'Co-op Campaign')::numeric,0)) as coop,
      greatest(coalesce((tags->>'PvP')::numeric,0), coalesce((tags->>'Competitive')::numeric,0),
               coalesce((tags->>'Team-Based')::numeric,0), coalesce((tags->>'Battle Royale')::numeric,0),
               coalesce((tags->>'Massively Multiplayer')::numeric,0), coalesce((tags->>'MMORPG')::numeric,0)) as pvp,
      greatest(coalesce((tags->>'Multiplayer')::numeric,0), coalesce((tags->>'Local Multiplayer')::numeric,0),
               coalesce((tags->>'4 Player Local')::numeric,0), coalesce((tags->>'Split Screen')::numeric,0),
               coalesce((tags->>'Asynchronous Multiplayer')::numeric,0)) as generic,
      coalesce(categories && array['Co-op','Online Co-op','LAN Co-op','Shared/Split Screen Co-op'], false) as cat_coop,
      coalesce(categories && array['PvP','Online PvP','LAN PvP','Shared/Split Screen PvP','MMO'], false) as cat_pvp,
      coalesce(categories && array['Multi-player','Shared/Split Screen'], false) as cat_multi,
      coalesce('Single-player' = any(categories), false) as cat_single
  ), s as (
    select *,
      case when coop + pvp > 0 then coop / (coop + pvp)
           when cat_coop and not cat_pvp then 1
           when cat_coop and cat_pvp then 0.5
           else 0 end as coop_share
    from v
  ), scored as (
    select *,
      greatest(coop, generic * coop_share) as coop_score,
      greatest(pvp, generic * (1 - coop_share)) as multi_score
    from s
  )
  select case
    when tags is null or tags = '{}'::jsonb then null
    when single = 0 and coop_score = 0 and multi_score = 0 then
      case when cat_single then 'single'
           when cat_coop then 'coop'
           when cat_pvp or cat_multi then 'multi' end
    when single >= coop_score and single >= multi_score then 'single'
    when coop_score >= multi_score then 'coop'
    else 'multi' end
  from scored
$$;

alter table public.catalog_games
  add column if not exists player_mode text
  check (player_mode in ('single', 'coop', 'multi'));

-- Kept current whenever enrichment rewrites tags or categories.
create or replace function public.set_catalog_player_mode()
returns trigger language plpgsql as $$
begin
  new.player_mode := public.player_mode_from_signals(new.tags::jsonb, new.categories);
  return new;
end $$;

drop trigger if exists catalog_games_player_mode on public.catalog_games;
create trigger catalog_games_player_mode
  before insert or update of tags, categories on public.catalog_games
  for each row execute function public.set_catalog_player_mode();

-- Backfill the whole catalogue in one pass.
update public.catalog_games
set player_mode = public.player_mode_from_signals(tags::jsonb, categories)
where player_mode is distinct from public.player_mode_from_signals(tags::jsonb, categories);

-- Append player_mode to the live view without restating its definition, so
-- nothing added to the view since the last checked-in copy is lost.
do $$
declare
  def text := pg_get_viewdef('public.user_games_with_catalog'::regclass);
  opts text[] := (select reloptions from pg_class where oid = 'public.user_games_with_catalog'::regclass);
begin
  if def !~ 'player_mode' then
    def := regexp_replace(def, '(\n\s*FROM\s)', E',\n    c.player_mode\\1');
    execute 'create or replace view public.user_games_with_catalog'
      || case when opts is not null then ' with (' || array_to_string(opts, ',') || ')' else '' end
      || ' as ' || def;
  end if;
end $$;

notify pgrst, 'reload schema';
