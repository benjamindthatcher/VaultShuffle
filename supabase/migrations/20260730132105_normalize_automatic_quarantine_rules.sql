update public.catalog_game_quarantine q
set matched_rule = case
      when exists (
        select 1 from unnest(coalesce(q.genres, array[]::text[]) || coalesce(q.categories, array[]::text[])) label
        where lower(trim(label)) = 'software'
      ) then 'steam_label:software'
      else 'steam_label:utilities'
    end,
    reason = case
      when exists (
        select 1 from unnest(coalesce(q.genres, array[]::text[]) || coalesce(q.categories, array[]::text[])) label
        where lower(trim(label)) = 'software'
      ) then 'Steam classified this AppID as software, not a game.'
      else 'Steam classified this AppID as utilities, not a game.'
    end,
    updated_at = now()
where q.source = 'automatic';
-- Version aligned with the production Supabase migration history.
