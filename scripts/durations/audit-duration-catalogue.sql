-- Whole-catalogue duration integrity audit.
--
-- This script is intentionally read-only. It uses one repeatable-read snapshot so
-- every result set describes the same database state. It audits quarantined rows
-- but never changes quarantine, duration evidence, jobs or catalogue projections.
--
-- Prerequisite: 20260825143500_harden_duration_evidence.sql has been applied.
-- Keep the policy_acceptable predicate and winner ordering synchronized with
-- public.reconcile_catalogue_duration(bigint, boolean). The accepted policy is:
--   * a coherent medium/high matched estimate with a provider game ID; and
--   * either HLTB evidence with an accepted validation method/tier pair; or
--   * conservative direct IGDB evidence (5+ submissions, 2+ values, no
--     derivative-product title, and no reused provider ID unless that estimate
--     carries an explicit duplicate-provider validation override).
-- IGDB parent/title matches remain review evidence and cannot become winners.

begin transaction isolation level repeatable read, read only;

-- 01. Catalogue state and protection totals.
select
  '01_catalogue_state_totals'::text as audit_section,
  case when grouping(game.duration_kind) = 1 then 'ALL' else game.duration_kind end as duration_kind,
  case when grouping(game.duration_status) = 1 then 'ALL' else game.duration_status end as duration_status,
  case
    when grouping(game.duration_manual_override) = 1 then 'ALL'
    else game.duration_manual_override::text
  end as manual_override,
  count(*) as games,
  count(*) filter (
    where game.main_story_minutes > 0
       or game.main_extras_minutes > 0
       or game.completionist_minutes > 0
  ) as games_with_positive_catalogue_value,
  count(*) filter (
    where game.main_story_minutes is null
      and game.main_extras_minutes is null
      and game.completionist_minutes is null
  ) as games_with_all_catalogue_values_null,
  count(*) filter (
    where exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    )
  ) as excluded_games,
  count(*) filter (
    where game.duration_source like 'manual%'
      and not game.duration_manual_override
  ) as manual_source_without_override
from public.catalog_games as game
group by grouping sets (
  (game.duration_kind, game.duration_status, game.duration_manual_override),
  ()
)
order by
  grouping(game.duration_kind) desc,
  game.duration_kind,
  game.duration_status,
  game.duration_manual_override;

with flagged as (
  select
    game.*,
    exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    ) as is_excluded,
    array_remove(array[
      case
        when (game.main_story_minutes is not null and game.main_story_minutes not between 1 and 120000)
          or (game.main_extras_minutes is not null and game.main_extras_minutes not between 1 and 120000)
          or (game.completionist_minutes is not null and game.completionist_minutes not between 1 and 120000)
        then 'catalogue_value_outside_1_to_120000'
      end,
      case
        when game.main_story_minutes is not null
          and game.main_extras_minutes is not null
          and game.main_extras_minutes < game.main_story_minutes
        then 'catalogue_extra_before_story'
      end,
      case
        when game.completionist_minutes is not null
          and coalesce(game.main_extras_minutes, game.main_story_minutes) is not null
          and game.completionist_minutes < coalesce(
            game.main_extras_minutes,
            game.main_story_minutes
          )
        then 'catalogue_completion_before_prior_tier'
      end,
      case
        when game.main_story_minutes is not null
          and game.completionist_minutes is not null
          and game.completionist_minutes::bigint >= game.main_story_minutes::bigint * 12
        then 'catalogue_completion_at_least_12x_story'
      end,
      case
        when game.duration_kind = 'finite'
          and not (
            coalesce(game.main_story_minutes, 0) > 0
            or coalesce(game.main_extras_minutes, 0) > 0
            or coalesce(game.completionist_minutes, 0) > 0
          )
        then 'finite_without_positive_value'
      end,
      case
        when game.duration_kind = 'finite'
          and game.duration_status is distinct from 'ready'
        then 'finite_not_ready'
      end,
      case
        when game.duration_kind in ('unknown', 'endless', 'not-applicable')
          and (
            game.main_story_minutes is not null
            or game.main_extras_minutes is not null
            or game.completionist_minutes is not null
          )
        then 'nonfinite_or_unknown_retains_values'
      end,
      case
        when game.duration_kind = 'unknown' and game.duration_status = 'ready'
        then 'unknown_marked_ready'
      end,
      case
        when game.duration_source is null and game.duration_source_game_id is not null
        then 'source_id_without_source'
      end
    ], null) as issue_codes
  from public.catalog_games as game
), ranked as (
  select
    flagged.*,
    row_number() over (
      order by cardinality(issue_codes) desc, review_total desc nulls last, steam_appid
    ) as example_rank
  from flagged
)
select
  '01_catalogue_shape_integrity'::text as audit_section,
  count(*) as catalogue_games,
  count(*) filter (where cardinality(issue_codes) > 0) as games_with_issue,
  count(*) filter (where 'catalogue_value_outside_1_to_120000' = any(issue_codes))
    as values_outside_hard_range,
  count(*) filter (where 'catalogue_extra_before_story' = any(issue_codes))
    as extra_before_story,
  count(*) filter (where 'catalogue_completion_before_prior_tier' = any(issue_codes))
    as completion_before_prior_tier,
  count(*) filter (where 'catalogue_completion_at_least_12x_story' = any(issue_codes))
    as completion_at_least_12x_story,
  count(*) filter (where 'finite_without_positive_value' = any(issue_codes))
    as finite_without_positive_value,
  count(*) filter (where 'nonfinite_or_unknown_retains_values' = any(issue_codes))
    as nonfinite_or_unknown_retains_values,
  jsonb_agg(
    jsonb_build_object(
      'steam_appid', steam_appid,
      'name', name,
      'duration_kind', duration_kind,
      'duration_status', duration_status,
      'duration_source', duration_source,
      'manual_override', duration_manual_override,
      'excluded', is_excluded,
      'issue_codes', issue_codes
    )
    order by example_rank
  ) filter (where cardinality(issue_codes) > 0 and example_rank <= 50) as issue_examples
from ranked;

-- 02. Matched-estimate value shape and hardened arbitration eligibility.
with matched as (
  select
    estimate.*,
    game.name as catalogue_name,
    game.steam_appid is null as missing_catalogue_game,
    (
      (estimate.main_story_minutes is not null)::int
      + (estimate.main_extra_minutes is not null)::int
      + (estimate.completionist_minutes is not null)::int
    ) as value_count,
    (
      (estimate.main_story_minutes > 0
        or estimate.main_extra_minutes > 0
        or estimate.completionist_minutes > 0)
      and (estimate.main_story_minutes is null or estimate.main_story_minutes between 1 and 120000)
      and (estimate.main_extra_minutes is null or estimate.main_extra_minutes between 1 and 120000)
      and (estimate.completionist_minutes is null or estimate.completionist_minutes between 1 and 120000)
      and (
        estimate.main_story_minutes is null
        or estimate.main_extra_minutes is null
        or estimate.main_extra_minutes >= estimate.main_story_minutes
      )
      and (
        estimate.completionist_minutes is null
        or coalesce(estimate.main_extra_minutes, estimate.main_story_minutes) is null
        or estimate.completionist_minutes >= coalesce(
          estimate.main_extra_minutes,
          estimate.main_story_minutes
        )
      )
      and (
        estimate.main_story_minutes is null
        or estimate.completionist_minutes is null
        or estimate.completionist_minutes::bigint
          < estimate.main_story_minutes::bigint * 12
      )
    ) as valid_shape,
    coalesce(
      lower(game.name) ~
        '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)',
      false
    ) as derivative_product_title,
    estimate.provider = 'igdb'
      and not (
        estimate.evidence @>
          '{"duplicate_provider_id_validated": true}'::jsonb
      )
      and exists (
        select 1
        from public.game_duration_estimates as sibling_estimate
        where sibling_estimate.provider = 'igdb'
          and sibling_estimate.match_status = 'matched'
          and sibling_estimate.provider_game_id = estimate.provider_game_id
          and sibling_estimate.steam_app_id <> estimate.steam_app_id
      ) as conflicting_igdb_sibling
  from public.game_duration_estimates as estimate
  left join public.catalog_games as game
    on game.steam_appid = estimate.steam_app_id
  where estimate.match_status = 'matched'
), evaluated as (
  select
    matched.*,
    coalesce(
      not matched.missing_catalogue_game
      and (
        matched.match_confidence in ('medium', 'high')
        or (
          matched.provider = 'hltb'
          and matched.match_confidence = 'low'
          and matched.evidence @> '{"identity_validated": true}'::jsonb
          and matched.evidence ->> 'verification_method' = 'profile_steam_exact'
          and matched.evidence ->> 'verification_tier' = 'steam_appid'
          and matched.evidence ->> 'duration_basis' = 'completion_times'
          and matched.evidence -> 'duration_issues' = '[]'::jsonb
          and (
            coalesce(matched.submission_count, 0) >= 2
            or matched.value_count >= 2
          )
        )
      )
      and matched.provider_game_id is not null
      and matched.valid_shape
      and (
        (
          matched.provider = 'hltb'
          and matched.evidence @> '{"identity_validated": true}'::jsonb
          and (
            (
              matched.evidence ->> 'verification_method' = 'profile_steam_exact'
              and matched.evidence ->> 'verification_tier' = 'steam_appid'
            )
            or (
              matched.evidence ->> 'verification_method' in (
                'safe_exact_title',
                'safe_exact_alias'
              )
              and matched.evidence ->> 'verification_tier' in (
                'exact_title',
                'mixed_script_title'
              )
            )
          )
        )
        or (
          matched.provider = 'igdb'
          and coalesce(matched.submission_count, 0) >= 5
          and matched.value_count >= 2
          and matched.catalogue_name is not null
          and not matched.derivative_product_title
          and not matched.conflicting_igdb_sibling
        )
      ),
      false
    ) as policy_acceptable
  from matched
)
select
  '02_matched_estimate_policy'::text as audit_section,
  case when grouping(provider) = 1 then 'ALL_PROVIDERS' else provider end as provider,
  count(*) as matched_rows,
  count(*) filter (where missing_catalogue_game) as orphan_estimates,
  count(*) filter (where provider_game_id is null) as missing_provider_game_id,
  count(*) filter (where match_confidence not in ('medium', 'high') or match_confidence is null)
    as confidence_not_auto_eligible,
  count(*) filter (where not coalesce(valid_shape, false)) as malformed_shape,
  count(*) filter (where value_count = 0) as all_values_null,
  count(*) filter (where value_count = 1) as exactly_one_value,
  count(*) filter (
    where main_story_minutes > 120000
       or main_extra_minutes > 120000
       or completionist_minutes > 120000
  ) as over_120000_minutes,
  count(*) filter (
    where main_story_minutes is not null
      and main_extra_minutes is not null
      and main_extra_minutes < main_story_minutes
  ) as main_extra_before_story,
  count(*) filter (
    where completionist_minutes is not null
      and coalesce(main_extra_minutes, main_story_minutes) is not null
      and completionist_minutes < coalesce(main_extra_minutes, main_story_minutes)
  ) as completionist_before_prior_tier,
  count(*) filter (
    where main_story_minutes is not null
      and completionist_minutes is not null
      and completionist_minutes::bigint >= main_story_minutes::bigint * 12
  ) as completionist_at_least_12x_story,
  count(*) filter (
    where provider = 'hltb'
      and not (
        evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            evidence ->> 'verification_method' = 'profile_steam_exact'
            and evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            evidence ->> 'verification_method' in (
              'safe_exact_title',
              'safe_exact_alias'
            )
            and evidence ->> 'verification_tier' in (
              'exact_title',
              'mixed_script_title'
            )
          )
        )
      )
  ) as unvalidated_hltb,
  count(*) filter (
    where provider = 'igdb'
      and coalesce(submission_count, 0) < 5
  ) as igdb_below_five_submissions,
  count(*) filter (
    where provider = 'igdb' and derivative_product_title
  ) as igdb_derivative_product_title,
  count(*) filter (where conflicting_igdb_sibling) as conflicting_igdb_sibling,
  count(*) filter (where policy_acceptable) as policy_acceptable_rows,
  count(*) filter (where not policy_acceptable) as review_only_or_rejected_rows
from evaluated
group by grouping sets ((provider), ())
order by grouping(provider) desc, provider;

with matched as (
  select
    estimate.*,
    game.name,
    game.review_total,
    array_remove(array[
      case when game.steam_appid is null then 'missing_catalogue_game' end,
      case when estimate.provider_game_id is null then 'missing_provider_game_id' end,
      case
        when estimate.match_confidence not in ('medium', 'high')
          or estimate.match_confidence is null
        then 'confidence_not_auto_eligible'
      end,
      case
        when not coalesce(
          (estimate.main_story_minutes > 0
            or estimate.main_extra_minutes > 0
            or estimate.completionist_minutes > 0)
          and (estimate.main_story_minutes is null or estimate.main_story_minutes between 1 and 120000)
          and (estimate.main_extra_minutes is null or estimate.main_extra_minutes between 1 and 120000)
          and (estimate.completionist_minutes is null or estimate.completionist_minutes between 1 and 120000)
          and (
            estimate.main_story_minutes is null
            or estimate.main_extra_minutes is null
            or estimate.main_extra_minutes >= estimate.main_story_minutes
          )
          and (
            estimate.completionist_minutes is null
            or coalesce(estimate.main_extra_minutes, estimate.main_story_minutes) is null
            or estimate.completionist_minutes >= coalesce(
              estimate.main_extra_minutes,
              estimate.main_story_minutes
            )
          )
          and (
            estimate.main_story_minutes is null
            or estimate.completionist_minutes is null
            or estimate.completionist_minutes::bigint
              < estimate.main_story_minutes::bigint * 12
          ),
          false
        )
        then 'malformed_duration_shape'
      end,
      case
        when estimate.provider = 'hltb'
          and not (
            estimate.evidence @> '{"identity_validated": true}'::jsonb
            and (
              (
                estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
                and estimate.evidence ->> 'verification_tier' = 'steam_appid'
              )
              or (
                estimate.evidence ->> 'verification_method' in (
                  'safe_exact_title',
                  'safe_exact_alias'
                )
                and estimate.evidence ->> 'verification_tier' in (
                  'exact_title',
                  'mixed_script_title'
                )
              )
            )
        )
        then 'hltb_identity_unvalidated'
      end,
      case
        when estimate.provider = 'igdb'
          and coalesce(estimate.submission_count, 0) < 5
        then 'igdb_below_five_submissions'
      end,
      case
        when estimate.provider = 'igdb'
          and (
            (estimate.main_story_minutes is not null)::int
            + (estimate.main_extra_minutes is not null)::int
            + (estimate.completionist_minutes is not null)::int
          ) < 2
        then 'igdb_fewer_than_two_values'
      end,
      case
        when estimate.provider = 'igdb'
          and lower(game.name) ~
            '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
        then 'igdb_derivative_product_title'
      end,
      case
        when estimate.provider = 'igdb'
          and not (
            estimate.evidence @>
              '{"duplicate_provider_id_validated": true}'::jsonb
          )
          and exists (
            select 1
            from public.game_duration_estimates as sibling_estimate
            where sibling_estimate.provider = 'igdb'
              and sibling_estimate.match_status = 'matched'
              and sibling_estimate.provider_game_id = estimate.provider_game_id
              and sibling_estimate.steam_app_id <> estimate.steam_app_id
          )
        then 'igdb_reused_provider_id_without_override'
      end,
      case
        when estimate.provider in ('igdb-parent', 'igdb-title')
        then 'non_direct_igdb_review_only'
      end,
      case
        when estimate.provider not in ('hltb', 'igdb', 'igdb-parent', 'igdb-title')
        then 'unsupported_provider'
      end
    ], null) as issue_codes
  from public.game_duration_estimates as estimate
  left join public.catalog_games as game
    on game.steam_appid = estimate.steam_app_id
  where estimate.match_status = 'matched'
)
select
  '02_matched_estimate_issue_examples'::text as audit_section,
  steam_app_id,
  name,
  provider,
  provider_game_id,
  match_confidence,
  submission_count,
  main_story_minutes,
  main_extra_minutes,
  completionist_minutes,
  issue_codes,
  review_total
from matched
where cardinality(issue_codes) > 0
order by cardinality(issue_codes) desc, review_total desc nulls last, steam_app_id, provider
limit 50;

-- 03. Reproduce all three reconciler choices: accepted winner, matched review
-- evidence and latest nonmatched evidence. Manual overrides, excluded products
-- and affirmative nonfinite classifications are deliberately protected and are
-- reported as divergences rather than projection defects.
with acceptable_estimates as (
  select estimate.*
  from public.game_duration_estimates as estimate
  join public.catalog_games as game
    on game.steam_appid = estimate.steam_app_id
  where estimate.match_status = 'matched'
    and (
      estimate.match_confidence in ('medium', 'high')
      or (
        estimate.provider = 'hltb'
        and estimate.match_confidence = 'low'
        and estimate.evidence @> '{"identity_validated": true}'::jsonb
        and estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
        and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        and estimate.evidence ->> 'duration_basis' = 'completion_times'
        and estimate.evidence -> 'duration_issues' = '[]'::jsonb
        and (
          coalesce(estimate.submission_count, 0) >= 2
          or (
            (estimate.main_story_minutes is not null)::int
            + (estimate.main_extra_minutes is not null)::int
            + (estimate.completionist_minutes is not null)::int
          ) >= 2
        )
      )
    )
    and estimate.provider_game_id is not null
    and (
      estimate.main_story_minutes > 0
      or estimate.main_extra_minutes > 0
      or estimate.completionist_minutes > 0
    )
    and (estimate.main_story_minutes is null or estimate.main_story_minutes between 1 and 120000)
    and (estimate.main_extra_minutes is null or estimate.main_extra_minutes between 1 and 120000)
    and (estimate.completionist_minutes is null or estimate.completionist_minutes between 1 and 120000)
    and (
      estimate.main_story_minutes is null
      or estimate.main_extra_minutes is null
      or estimate.main_extra_minutes >= estimate.main_story_minutes
    )
    and (
      estimate.completionist_minutes is null
      or coalesce(estimate.main_extra_minutes, estimate.main_story_minutes) is null
      or estimate.completionist_minutes >= coalesce(
        estimate.main_extra_minutes,
        estimate.main_story_minutes
      )
    )
    and (
      estimate.main_story_minutes is null
      or estimate.completionist_minutes is null
      or estimate.completionist_minutes::bigint < estimate.main_story_minutes::bigint * 12
    )
    and (
      (
        estimate.provider = 'hltb'
        and estimate.evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
            and estimate.evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            estimate.evidence ->> 'verification_method' in (
              'safe_exact_title',
              'safe_exact_alias'
            )
            and estimate.evidence ->> 'verification_tier' in (
              'exact_title',
              'mixed_script_title'
            )
          )
        )
      )
      or (
        estimate.provider = 'igdb'
        and coalesce(estimate.submission_count, 0) >= 5
        and (
          (estimate.main_story_minutes is not null)::int
          + (estimate.main_extra_minutes is not null)::int
          + (estimate.completionist_minutes is not null)::int
        ) >= 2
        and lower(game.name) !~
          '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
        and (
          estimate.evidence @>
            '{"duplicate_provider_id_validated": true}'::jsonb
          or not exists (
            select 1
            from public.game_duration_estimates as sibling_estimate
            where sibling_estimate.provider = 'igdb'
              and sibling_estimate.match_status = 'matched'
              and sibling_estimate.provider_game_id = estimate.provider_game_id
              and sibling_estimate.steam_app_id <> estimate.steam_app_id
          )
        )
      )
    )
), ranked_winners as (
  select
    estimate.*,
    row_number() over (
      partition by estimate.steam_app_id
      order by
        case estimate.match_confidence when 'high' then 2 else 1 end desc,
        case estimate.provider when 'hltb' then 2 when 'igdb' then 1 end desc,
        (
          (estimate.main_story_minutes is not null)::int
          + (estimate.main_extra_minutes is not null)::int
          + (estimate.completionist_minutes is not null)::int
        ) desc,
        coalesce(estimate.submission_count, 0) desc,
        estimate.checked_at desc nulls last,
        estimate.provider_game_id asc nulls last
    ) as winner_rank
  from acceptable_estimates as estimate
), winners as (
  select *
  from ranked_winners
  where winner_rank = 1
), ranked_review_matches as (
  select
    estimate.*,
    row_number() over (
      partition by estimate.steam_app_id
      order by
        case estimate.match_confidence
          when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0
        end desc,
        case estimate.provider
          when 'hltb' then 4 when 'igdb' then 3 when 'igdb-parent' then 2
          when 'igdb-title' then 1 else 0
        end desc,
        estimate.checked_at desc nulls last,
        estimate.provider_game_id asc nulls last
    ) as review_rank
  from public.game_duration_estimates as estimate
  where estimate.match_status = 'matched'
), review_matches as (
  select *
  from ranked_review_matches
  where review_rank = 1
), ranked_latest_evidence as (
  select
    estimate.*,
    row_number() over (
      partition by estimate.steam_app_id
      order by
        case estimate.match_status
          when 'no_duration' then 4 when 'ambiguous' then 3
          when 'needs_review' then 2 when 'not_found' then 1
        end desc,
        estimate.checked_at desc nulls last,
        estimate.provider asc
    ) as evidence_rank
  from public.game_duration_estimates as estimate
  where estimate.match_status in ('no_duration', 'ambiguous', 'needs_review', 'not_found')
), latest_evidence as (
  select *
  from ranked_latest_evidence
  where evidence_rank = 1
), expected as (
  select
    game.*,
    exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    ) as is_excluded,
    case
      when winner.steam_app_id is not null then 'accepted_finite'
      when review_match.steam_app_id is not null then 'matched_review'
      when latest.steam_app_id is not null then 'nonmatched_review'
      else 'no_evidence'
    end as expected_projection,
    case when winner.steam_app_id is not null then winner.main_story_minutes end
      as expected_main_story_minutes,
    case when winner.steam_app_id is not null then winner.main_extra_minutes end
      as expected_main_extras_minutes,
    case when winner.steam_app_id is not null then winner.completionist_minutes end
      as expected_completionist_minutes,
    case
      when winner.steam_app_id is not null then winner.provider
      when review_match.steam_app_id is not null then review_match.provider
      when latest.steam_app_id is not null then latest.provider
    end as expected_duration_source,
    case
      when winner.steam_app_id is not null then winner.provider_game_id::text
      when review_match.steam_app_id is not null then review_match.provider_game_id::text
      when latest.steam_app_id is not null then latest.provider_game_id::text
    end as expected_duration_source_game_id,
    case
      when winner.steam_app_id is not null then coalesce(winner.provider_updated_at, winner.checked_at)
      when review_match.steam_app_id is not null
        then coalesce(review_match.provider_updated_at, review_match.checked_at)
      when latest.steam_app_id is not null then coalesce(latest.provider_updated_at, latest.checked_at)
    end as expected_duration_source_updated_at,
    case
      when winner.steam_app_id is not null then winner.match_confidence
      when review_match.match_confidence in ('low', 'medium', 'high')
        then review_match.match_confidence
      when latest.match_confidence in ('low', 'medium', 'high') then latest.match_confidence
    end as expected_duration_confidence,
    case
      when winner.steam_app_id is not null then 'ready'
      when review_match.steam_app_id is not null or latest.steam_app_id is not null
        then 'review_required'
    end as expected_duration_status,
    case
      when winner.steam_app_id is not null then 'finite'
      when review_match.steam_app_id is not null or latest.steam_app_id is not null
        then 'unknown'
    end as expected_duration_kind,
    winner.provider as winner_provider,
    winner.provider_game_id as winner_provider_game_id
  from public.catalog_games as game
  left join winners as winner
    on winner.steam_app_id = game.steam_appid
  left join review_matches as review_match
    on review_match.steam_app_id = game.steam_appid
  left join latest_evidence as latest
    on latest.steam_app_id = game.steam_appid
), evaluated as (
  select
    expected.*,
    case
      when expected.duration_manual_override then 'manual_override'
      when expected.is_excluded then 'excluded'
      when expected.duration_kind in ('endless', 'not-applicable') then 'nonfinite_classification'
      else 'unprotected'
    end as protection,
    expected.expected_projection <> 'no_evidence'
      and row(
        expected.main_story_minutes,
        expected.main_extras_minutes,
        expected.completionist_minutes,
        expected.duration_source,
        expected.duration_source_game_id,
        expected.duration_source_updated_at,
        expected.duration_confidence,
        expected.duration_status,
        expected.duration_kind
      ) is distinct from row(
        expected.expected_main_story_minutes,
        expected.expected_main_extras_minutes,
        expected.expected_completionist_minutes,
        expected.expected_duration_source,
        expected.expected_duration_source_game_id,
        expected.expected_duration_source_updated_at,
        expected.expected_duration_confidence,
        expected.expected_duration_status,
        expected.expected_duration_kind
      ) as projection_diverges
  from expected
), ranked as (
  select
    evaluated.*,
    row_number() over (
      partition by expected_projection, protection
      order by projection_diverges desc, review_total desc nulls last, steam_appid
    ) as example_rank
  from evaluated
  where expected_projection <> 'no_evidence'
)
select
  '03_projection_integrity'::text as audit_section,
  expected_projection,
  protection,
  count(*) as games,
  count(*) filter (where not projection_diverges) as matches_expected_projection,
  count(*) filter (
    where projection_diverges
      and protection = 'unprotected'
  ) as actionable_projection_mismatches,
  count(*) filter (
    where projection_diverges
      and protection <> 'unprotected'
  ) as protected_projection_divergences,
  jsonb_agg(
    jsonb_build_object(
      'steam_appid', steam_appid,
      'name', name,
      'actual_source', duration_source,
      'actual_kind', duration_kind,
      'actual_status', duration_status,
      'expected_source', expected_duration_source,
      'expected_kind', expected_duration_kind,
      'expected_status', expected_duration_status,
      'winner_provider', winner_provider,
      'winner_provider_game_id', winner_provider_game_id
    )
    order by example_rank
  ) filter (where projection_diverges and example_rank <= 10) as divergence_examples
from ranked
group by expected_projection, protection
order by expected_projection, protection;

-- 04. Ready HLTB projections must be backed by the same HLTB identity row and
-- validated evidence. This catches legacy ready rows before they are reconciled
-- under the hardened policy.
with ready_hltb as (
  select
    game.*,
    estimate.steam_app_id as estimate_steam_app_id,
    estimate.provider_game_id as estimate_provider_game_id,
    estimate.match_status,
    estimate.match_confidence,
    estimate.main_story_minutes as estimate_main_story_minutes,
    estimate.main_extra_minutes as estimate_main_extra_minutes,
    estimate.completionist_minutes as estimate_completionist_minutes,
    estimate.evidence,
    exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    ) as is_excluded
  from public.catalog_games as game
  left join public.game_duration_estimates as estimate
    on estimate.steam_app_id = game.steam_appid
   and estimate.provider = 'hltb'
  where game.duration_source = 'hltb'
    and game.duration_status = 'ready'
), flagged as (
  select
    ready_hltb.*,
    array_remove(array[
      case when duration_source_game_id is null then 'catalogue_source_id_missing' end,
      case when estimate_steam_app_id is null then 'hltb_estimate_missing' end,
      case
        when estimate_steam_app_id is not null
          and estimate_provider_game_id is null
        then 'estimate_provider_id_missing'
      end,
      case
        when estimate_steam_app_id is not null
          and estimate_provider_game_id::text is distinct from duration_source_game_id
        then 'catalogue_source_id_mismatch'
      end,
      case when match_status is distinct from 'matched' then 'estimate_not_matched' end,
      case
        when not coalesce(
          evidence @> '{"identity_validated": true}'::jsonb
          and (
            (
              evidence ->> 'verification_method' = 'profile_steam_exact'
              and evidence ->> 'verification_tier' = 'steam_appid'
            )
            or (
              evidence ->> 'verification_method' in (
                'safe_exact_title',
                'safe_exact_alias'
              )
              and evidence ->> 'verification_tier' in (
                'exact_title',
                'mixed_script_title'
              )
            )
          ),
          false
        )
        then 'identity_evidence_not_accepted'
      end,
      case
        when match_confidence not in ('medium', 'high') or match_confidence is null
        then 'confidence_not_auto_eligible'
      end,
      case
        when estimate_steam_app_id is not null
          and not coalesce(
            (estimate_main_story_minutes > 0
              or estimate_main_extra_minutes > 0
              or estimate_completionist_minutes > 0)
            and (estimate_main_story_minutes is null or estimate_main_story_minutes between 1 and 120000)
            and (estimate_main_extra_minutes is null or estimate_main_extra_minutes between 1 and 120000)
            and (estimate_completionist_minutes is null or estimate_completionist_minutes between 1 and 120000)
            and (
              estimate_main_story_minutes is null
              or estimate_main_extra_minutes is null
              or estimate_main_extra_minutes >= estimate_main_story_minutes
            )
            and (
              estimate_completionist_minutes is null
              or coalesce(estimate_main_extra_minutes, estimate_main_story_minutes) is null
              or estimate_completionist_minutes >= coalesce(
                estimate_main_extra_minutes,
                estimate_main_story_minutes
              )
            )
            and (
              estimate_main_story_minutes is null
              or estimate_completionist_minutes is null
              or estimate_completionist_minutes::bigint
                < estimate_main_story_minutes::bigint * 12
            ),
            false
          )
        then 'malformed_estimate_shape'
      end,
      case
        when estimate_steam_app_id is not null
          and row(main_story_minutes, main_extras_minutes, completionist_minutes)
            is distinct from row(
              estimate_main_story_minutes,
              estimate_main_extra_minutes,
              estimate_completionist_minutes
            )
        then 'catalogue_values_differ_from_estimate'
      end
    ], null) as issue_codes
  from ready_hltb
), ranked as (
  select
    flagged.*,
    row_number() over (
      order by cardinality(issue_codes) desc, review_total desc nulls last, steam_appid
    ) as example_rank
  from flagged
)
select
  '04_unvalidated_hltb_ready'::text as audit_section,
  count(*) as ready_hltb_games,
  count(*) filter (where cardinality(issue_codes) > 0) as ready_hltb_with_issue,
  count(*) filter (where 'identity_evidence_not_accepted' = any(issue_codes))
    as identity_evidence_not_accepted,
  count(*) filter (where 'hltb_estimate_missing' = any(issue_codes)) as missing_estimate,
  count(*) filter (where 'catalogue_source_id_mismatch' = any(issue_codes)) as source_id_mismatch,
  count(*) filter (where 'malformed_estimate_shape' = any(issue_codes)) as malformed_estimate_shape,
  count(*) filter (where duration_manual_override) as manual_override_rows,
  count(*) filter (where is_excluded) as excluded_rows,
  jsonb_agg(
    jsonb_build_object(
      'steam_appid', steam_appid,
      'name', name,
      'issue_codes', issue_codes,
      'manual_override', duration_manual_override,
      'excluded', is_excluded
    )
    order by example_rank
  ) filter (where cardinality(issue_codes) > 0 and example_rank <= 50) as issue_examples
from ranked;

-- 05. Catalogue/estimate/job linkage and terminal-state consistency.
with job_audit as (
  select
    game.steam_appid,
    game.name,
    game.review_total,
    game.duration_kind,
    game.duration_status,
    game.duration_source,
    game.duration_source_game_id,
    game.duration_manual_override,
    job.status as job_status,
    job.locked_at,
    job.locked_by,
    array_remove(array[
      case when job.steam_app_id is null then 'catalogue_game_missing_job' end,
      case
        when job.status = 'completed'
          and not (
            game.duration_manual_override
            or (
              game.duration_status = 'ready'
              and game.duration_kind in ('finite', 'endless', 'not-applicable')
            )
          )
        then 'completed_job_without_resolved_duration'
      end,
      case
        when job.status = 'processing' and job.locked_at is null
        then 'processing_job_without_lock_timestamp'
      end,
      case
        when job.status = 'processing'
          and job.locked_at < now() - interval '6 hours'
        then 'stale_processing_lock'
      end,
      case
        when job.status <> 'processing'
          and (job.locked_at is not null or job.locked_by is not null)
        then 'nonprocessing_job_retains_lock'
      end,
      case
        when game.duration_source in ('hltb', 'igdb', 'igdb-parent', 'igdb-title')
          and not exists (
            select 1
            from public.game_duration_estimates as estimate
            where estimate.steam_app_id = game.steam_appid
              and estimate.provider = game.duration_source
              and estimate.provider_game_id::text is not distinct from game.duration_source_game_id
          )
        then 'catalogue_projection_missing_aligned_estimate'
      end
    ], null) as issue_codes
  from public.catalog_games as game
  left join public.game_duration_jobs as job
    on job.steam_app_id = game.steam_appid
), ranked as (
  select
    job_audit.*,
    row_number() over (
      order by cardinality(issue_codes) desc, review_total desc nulls last, steam_appid
    ) as example_rank
  from job_audit
), orphan_jobs as (
  select count(*) as jobs
  from public.game_duration_jobs as job
  left join public.catalog_games as game
    on game.steam_appid = job.steam_app_id
  where game.steam_appid is null
), orphan_estimates as (
  select count(*) as estimates
  from public.game_duration_estimates as estimate
  left join public.catalog_games as game
    on game.steam_appid = estimate.steam_app_id
  where game.steam_appid is null
)
select
  '05_job_and_linkage_integrity'::text as audit_section,
  count(*) as catalogue_games,
  count(*) filter (where 'catalogue_game_missing_job' = any(issue_codes)) as missing_jobs,
  count(*) filter (where 'completed_job_without_resolved_duration' = any(issue_codes))
    as completed_without_resolved_duration,
  count(*) filter (where 'processing_job_without_lock_timestamp' = any(issue_codes))
    as processing_without_lock_timestamp,
  count(*) filter (where 'stale_processing_lock' = any(issue_codes)) as stale_processing_locks,
  count(*) filter (where 'nonprocessing_job_retains_lock' = any(issue_codes))
    as nonprocessing_jobs_with_lock,
  count(*) filter (where 'catalogue_projection_missing_aligned_estimate' = any(issue_codes))
    as projections_missing_aligned_estimate,
  (select jobs from orphan_jobs) as orphan_jobs,
  (select estimates from orphan_estimates) as orphan_estimates,
  jsonb_agg(
    jsonb_build_object(
      'steam_appid', steam_appid,
      'name', name,
      'duration_kind', duration_kind,
      'duration_status', duration_status,
      'duration_source', duration_source,
      'job_status', job_status,
      'issue_codes', issue_codes
    )
    order by example_rank
  ) filter (where cardinality(issue_codes) > 0 and example_rank <= 50) as issue_examples
from ranked;

-- 06. Protection and provenance invariants that can be established without a
-- historical before/after snapshot. A manual lock may intentionally preserve a
-- provider projection, so the corresponding source check is advisory. Protected
-- projection differences are counted separately in section 03.
with protection_rows as (
  select
    game.*,
    exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    ) as is_excluded
  from public.catalog_games as game
), issues as (
  select
    issue.issue_code,
    count(*) as games
  from protection_rows as game
  cross join lateral (
    values
      (
        'manual_source_without_override'::text,
        game.duration_source like 'manual%' and not game.duration_manual_override
      ),
      (
        'manual_override_without_manual_source_advisory'::text,
        game.duration_manual_override
          and coalesce(game.duration_source, '') not like 'manual%'
      ),
      (
        'manual_override_not_ready'::text,
        game.duration_manual_override and game.duration_status is distinct from 'ready'
      ),
      (
        'manual_override_and_excluded'::text,
        game.duration_manual_override and game.is_excluded
      ),
      (
        'excluded_with_ready_finite_projection_informational'::text,
        game.is_excluded
          and game.duration_kind = 'finite'
          and game.duration_status = 'ready'
      )
  ) as issue(issue_code, applies)
  where issue.applies
  group by issue.issue_code
), quarantine_orphans as (
  select count(*) as games
  from public.catalog_game_quarantine as quarantine
  left join public.catalog_games as game
    on game.steam_appid = quarantine.steam_appid
  where quarantine.review_status = 'excluded'
    and game.steam_appid is null
)
select
  '06_protection_invariants'::text as audit_section,
  issue_code,
  games
from issues

union all

select
  '06_protection_invariants'::text as audit_section,
  'excluded_quarantine_without_catalogue_row'::text as issue_code,
  games
from quarantine_orphans
where games > 0
order by issue_code;

-- 07. Stale or internally inconsistent automatic nonfinite classifications.
-- These are review candidates, not automatic quarantine decisions. Advertising
-- is deliberately not used as a non-game signal.
with acceptable_estimates as (
  select estimate.*
  from public.game_duration_estimates as estimate
  join public.catalog_games as game
    on game.steam_appid = estimate.steam_app_id
  where estimate.match_status = 'matched'
    and (
      estimate.match_confidence in ('medium', 'high')
      or (
        estimate.provider = 'hltb'
        and estimate.match_confidence = 'low'
        and estimate.evidence @> '{"identity_validated": true}'::jsonb
        and estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
        and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        and estimate.evidence ->> 'duration_basis' = 'completion_times'
        and estimate.evidence -> 'duration_issues' = '[]'::jsonb
        and (
          coalesce(estimate.submission_count, 0) >= 2
          or (
            (estimate.main_story_minutes is not null)::int
            + (estimate.main_extra_minutes is not null)::int
            + (estimate.completionist_minutes is not null)::int
          ) >= 2
        )
      )
    )
    and estimate.provider_game_id is not null
    and (
      estimate.main_story_minutes > 0
      or estimate.main_extra_minutes > 0
      or estimate.completionist_minutes > 0
    )
    and (estimate.main_story_minutes is null or estimate.main_story_minutes between 1 and 120000)
    and (estimate.main_extra_minutes is null or estimate.main_extra_minutes between 1 and 120000)
    and (estimate.completionist_minutes is null or estimate.completionist_minutes between 1 and 120000)
    and (
      estimate.main_story_minutes is null
      or estimate.main_extra_minutes is null
      or estimate.main_extra_minutes >= estimate.main_story_minutes
    )
    and (
      estimate.completionist_minutes is null
      or coalesce(estimate.main_extra_minutes, estimate.main_story_minutes) is null
      or estimate.completionist_minutes >= coalesce(
        estimate.main_extra_minutes,
        estimate.main_story_minutes
      )
    )
    and (
      estimate.main_story_minutes is null
      or estimate.completionist_minutes is null
      or estimate.completionist_minutes::bigint < estimate.main_story_minutes::bigint * 12
    )
    and (
      (
        estimate.provider = 'hltb'
        and estimate.evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
            and estimate.evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            estimate.evidence ->> 'verification_method' in (
              'safe_exact_title',
              'safe_exact_alias'
            )
            and estimate.evidence ->> 'verification_tier' in (
              'exact_title',
              'mixed_script_title'
            )
          )
        )
      )
      or (
        estimate.provider = 'igdb'
        and coalesce(estimate.submission_count, 0) >= 5
        and (
          (estimate.main_story_minutes is not null)::int
          + (estimate.main_extra_minutes is not null)::int
          + (estimate.completionist_minutes is not null)::int
        ) >= 2
        and lower(game.name) !~
          '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
        and (
          estimate.evidence @>
            '{"duplicate_provider_id_validated": true}'::jsonb
          or not exists (
            select 1
            from public.game_duration_estimates as sibling_estimate
            where sibling_estimate.provider = 'igdb'
              and sibling_estimate.match_status = 'matched'
              and sibling_estimate.provider_game_id = estimate.provider_game_id
              and sibling_estimate.steam_app_id <> estimate.steam_app_id
          )
        )
      )
    )
), finite_winners as (
  select distinct steam_app_id
  from acceptable_estimates
), nonfinite as (
  select
    game.*,
    winner.steam_app_id is not null as has_acceptable_finite_evidence,
    lower(btrim(coalesce(game.steam_type, ''))) = 'game' as is_steam_game,
    lower(game.name) !~
      '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
      as is_primary_title,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) in ('single-player', 'single player')
    ) as official_single_player,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) in (
        'multi-player', 'multiplayer', 'mmo', 'pvp', 'online pvp'
      )
    ) as official_multiplayer,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) = 'online co-op'
    ) as official_online_coop,
    exists (
      select 1
      from unnest(
        coalesce(game.genres, array[]::text[])
        || coalesce(game.categories, array[]::text[])
      ) as signal(value)
      where lower(btrim(signal.value)) in (
        'massively multiplayer', 'mmo', 'mmorpg'
      )
    ) as official_mmo,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) in ('pvp', 'online pvp')
    ) as official_pvp
  from public.catalog_games as game
  left join finite_winners as winner
    on winner.steam_app_id = game.steam_appid
  where game.duration_kind in ('endless', 'not-applicable')
    and not game.duration_manual_override
    and not exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    )
), tag_rows as (
  select
    game.steam_appid,
    lower(btrim(tag.key)) as tag,
    case
      when tag.value #>> '{}' ~ '^[0-9]+([.][0-9]+)?$'
        then (tag.value #>> '{}')::numeric
    end as votes
  from nonfinite as game
  left join lateral jsonb_each(coalesce(game.tags, '{}'::jsonb)) as tag(key, value)
    on true
), tag_maximums as (
  select
    steam_appid,
    max(votes) filter (where votes > 0) as top_votes
  from tag_rows
  group by steam_appid
), tag_flags as (
  select
    row.steam_appid,
    coalesce(bool_or(row.tag in (
      'singleplayer', 'single-player', 'single player', 'story rich',
      'campaign', 'co-op campaign', 'multiple endings', 'visual novel'
    )), false) as has_single_player_or_story_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.65
      and row.tag in ('massively multiplayer', 'mmo', 'mmorpg')
    ), false) as has_dominant_mmo_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.65
      and row.tag in ('battle royale', 'moba')
    ), false) as has_dominant_pvp_loop_tag,
    coalesce(bool_or(row.tag in (
      'auto battler', 'battle royale', 'hero shooter', 'massively multiplayer',
      'mmo', 'mmorpg', 'moba'
    )), false) as has_distinctive_online_loop_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.35
      and row.tag in (
        'competitive', 'esports', 'e-sports', 'online pvp', 'pvp', 'team-based'
      )
    ), false) as has_weighted_competitive_loop_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.65
      and row.tag in ('open world survival craft', 'sandbox')
    ), false) as has_dominant_sandbox_loop_tag
  from tag_rows as row
  join tag_maximums as maximum
    on maximum.steam_appid = row.steam_appid
  group by row.steam_appid
), hltb_flags as (
  select
    game.steam_appid,
    coalesce(bool_or(
      estimate.provider = 'hltb'
      and estimate.match_status = 'no_duration'
      and estimate.match_confidence in ('medium', 'high')
      and estimate.provider_game_id is not null
      and estimate.main_story_minutes is null
      and estimate.main_extra_minutes is null
      and estimate.completionist_minutes is null
      and estimate.evidence @> '{"identity_validated": true}'::jsonb
      and estimate.evidence ->> 'duration_basis' = 'no_duration'
      and (
        (
          estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
          and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        )
        or (
          estimate.evidence ->> 'verification_method' in (
            'safe_exact_title', 'safe_exact_alias'
          )
          and estimate.evidence ->> 'verification_tier' in (
            'exact_title', 'mixed_script_title'
          )
        )
      )
      and estimate.evidence #>> '{hltb_modes,single_player}' = 'false'
      and estimate.evidence #>> '{hltb_modes,multiplayer}' = 'true'
    ), false) as has_validated_hltb_multiplayer_no_duration,
    coalesce(bool_or(
      estimate.provider = 'hltb'
      and estimate.match_status = 'no_duration'
      and estimate.match_confidence in ('medium', 'high')
      and estimate.provider_game_id is not null
      and estimate.main_story_minutes is null
      and estimate.main_extra_minutes is null
      and estimate.completionist_minutes is null
      and estimate.evidence @> '{"identity_validated": true}'::jsonb
      and estimate.evidence ->> 'duration_basis' = 'no_duration'
      and (
        (
          estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
          and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        )
        or (
          estimate.evidence ->> 'verification_method' in (
            'safe_exact_title', 'safe_exact_alias'
          )
          and estimate.evidence ->> 'verification_tier' in (
            'exact_title', 'mixed_script_title'
          )
        )
      )
      and estimate.evidence #>> '{hltb_modes,single_player}' = 'false'
      and estimate.evidence #>> '{hltb_modes,co_op}' = 'true'
    ), false) as has_validated_hltb_coop_no_duration
  from nonfinite as game
  left join public.game_duration_estimates as estimate
    on estimate.steam_app_id = game.steam_appid
  group by game.steam_appid
), audited as (
  select
    game.*,
    tags.has_single_player_or_story_tag,
    (
      game.official_multiplayer
      and (
        game.official_mmo
        or game.official_pvp
        or tags.has_dominant_mmo_tag
        or tags.has_dominant_pvp_loop_tag
        or tags.has_distinctive_online_loop_tag
        or tags.has_weighted_competitive_loop_tag
        or tags.has_dominant_sandbox_loop_tag
      )
    ) as steam_loop_signal,
    (
      hltb.has_validated_hltb_multiplayer_no_duration
      and game.official_multiplayer
    ) or (
      hltb.has_validated_hltb_coop_no_duration
      and game.official_online_coop
      and game.official_multiplayer
      and (
        game.official_mmo
        or game.official_pvp
        or tags.has_dominant_mmo_tag
        or tags.has_dominant_pvp_loop_tag
        or tags.has_distinctive_online_loop_tag
        or tags.has_weighted_competitive_loop_tag
        or tags.has_dominant_sandbox_loop_tag
      )
    ) as validated_hltb_modes
  from nonfinite as game
  join tag_flags as tags on tags.steam_appid = game.steam_appid
  join hltb_flags as hltb on hltb.steam_appid = game.steam_appid
), flagged as (
  select
    audited.*,
    array_remove(array[
      case when has_acceptable_finite_evidence then 'acceptable_finite_evidence' end,
      case
        when main_story_minutes is not null
          or main_extras_minutes is not null
          or completionist_minutes is not null
        then 'nonfinite_has_catalogue_values'
      end,
      case when duration_status is distinct from 'ready' then 'nonfinite_not_ready' end,
      case when duration_kind = 'not-applicable' then 'automatic_not_applicable' end,
      case when duration_source is distinct from 'classification'
        then 'nonfinite_provenance_not_normalized' end,
      case when not is_steam_game then 'not_a_steam_game' end,
      case when not is_primary_title then 'derivative_product_title' end,
      case when official_single_player then 'official_single_player' end,
      case when has_single_player_or_story_tag
        then 'story_or_single_player_tag' end,
      case when not (steam_loop_signal or validated_hltb_modes)
        then 'missing_corroborated_online_loop' end
    ], null) as issue_codes
  from audited
), ranked as (
  select
    flagged.*,
    row_number() over (
      order by cardinality(issue_codes) desc, review_total desc nulls last, steam_appid
    ) as example_rank
  from flagged
)
select
  '07_stale_nonfinite_classifications'::text as audit_section,
  count(*) as active_automatic_nonfinite,
  count(*) filter (where cardinality(issue_codes) > 0) as review_candidates,
  count(*) filter (where has_acceptable_finite_evidence) as finite_evidence_conflicts,
  count(*) filter (where 'nonfinite_has_catalogue_values' = any(issue_codes))
    as rows_with_catalogue_values,
  count(*) filter (where 'automatic_not_applicable' = any(issue_codes))
    as automatic_not_applicable,
  count(*) filter (where 'missing_corroborated_online_loop' = any(issue_codes))
    as unsupported_automatic_endless,
  jsonb_agg(
    jsonb_build_object(
      'steam_appid', steam_appid,
      'name', name,
      'duration_kind', duration_kind,
      'duration_source', duration_source,
      'review_total', review_total,
      'issue_codes', issue_codes
    )
    order by example_rank
  ) filter (where cardinality(issue_codes) > 0 and example_rank <= 50) as issue_examples
from ranked;

-- 08. Evidence-document completeness. HLTB arbitration requires both the
-- validation marker and an approved verification method/tier pair.
select
  '08_evidence_gaps'::text as audit_section,
  estimate.provider,
  estimate.match_status,
  count(*) as estimate_rows,
  count(*) filter (where jsonb_typeof(estimate.evidence) <> 'object') as evidence_not_object,
  count(*) filter (where estimate.evidence = '{}'::jsonb) as empty_evidence,
  count(*) filter (
    where estimate.provider = 'hltb'
      and estimate.match_status in ('matched', 'no_duration')
      and not (
        estimate.evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
            and estimate.evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            estimate.evidence ->> 'verification_method' in (
              'safe_exact_title',
              'safe_exact_alias'
            )
            and estimate.evidence ->> 'verification_tier' in (
              'exact_title',
              'mixed_script_title'
            )
          )
        )
      )
  ) as hltb_identity_pair_not_accepted,
  count(*) filter (
    where estimate.provider = 'hltb'
      and estimate.evidence @> '{"identity_validated": true}'::jsonb
      and nullif(estimate.evidence ->> 'verification_method', '') is null
  ) as validated_hltb_missing_method,
  count(*) filter (
    where estimate.provider = 'hltb'
      and estimate.evidence @> '{"identity_validated": true}'::jsonb
      and nullif(estimate.evidence ->> 'verification_tier', '') is null
  ) as validated_hltb_missing_tier,
  count(*) filter (
    where estimate.provider = 'hltb'
      and estimate.match_status = 'matched'
      and nullif(estimate.evidence ->> 'duration_basis', '') is null
  ) as matched_hltb_missing_duration_basis,
  count(*) filter (
    where estimate.provider = 'hltb'
      and estimate.match_status = 'no_duration'
      and not (estimate.evidence ? 'hltb_modes')
  ) as hltb_no_duration_missing_modes_key,
  count(*) filter (
    where estimate.provider = 'igdb'
      and estimate.match_status = 'matched'
      and estimate.provider_game_id is not null
      and not (
        estimate.evidence @>
          '{"duplicate_provider_id_validated": true}'::jsonb
      )
      and exists (
        select 1
        from public.game_duration_estimates as sibling_estimate
        where sibling_estimate.provider = 'igdb'
          and sibling_estimate.match_status = 'matched'
          and sibling_estimate.provider_game_id = estimate.provider_game_id
          and sibling_estimate.steam_app_id <> estimate.steam_app_id
      )
  ) as igdb_reused_id_missing_override,
  count(*) filter (
    where estimate.provider = 'igdb'
      and estimate.match_status = 'matched'
      and estimate.evidence @>
        '{"duplicate_provider_id_validated": true}'::jsonb
      and not exists (
        select 1
        from public.game_duration_estimates as sibling_estimate
        where sibling_estimate.provider = 'igdb'
          and sibling_estimate.match_status = 'matched'
          and sibling_estimate.provider_game_id = estimate.provider_game_id
          and sibling_estimate.steam_app_id <> estimate.steam_app_id
      )
  ) as igdb_duplicate_override_without_reuse
from public.game_duration_estimates as estimate
group by estimate.provider, estimate.match_status
order by estimate.provider, estimate.match_status;

-- 09. Provider identities reused across Steam AppIDs. Reuse is never accepted
-- for direct IGDB evidence unless the individual estimate has an explicit
-- duplicate-provider validation override. Reused HLTB page IDs remain an
-- identity-review risk even if individual rows carry validation evidence.
with reused_ids as (
  select
    estimate.provider,
    estimate.provider_game_id,
    count(distinct estimate.steam_app_id) as steam_app_count,
    bool_and(
      estimate.provider <> 'hltb'
      or (
        estimate.evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
            and estimate.evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            estimate.evidence ->> 'verification_method' in (
              'safe_exact_title',
              'safe_exact_alias'
            )
            and estimate.evidence ->> 'verification_tier' in (
              'exact_title',
              'mixed_script_title'
            )
          )
        )
      )
    ) as every_hltb_link_validated,
    count(*) filter (
      where estimate.provider = 'igdb'
        and estimate.evidence @>
          '{"duplicate_provider_id_validated": true}'::jsonb
    ) as igdb_override_links,
    count(*) filter (
      where estimate.provider = 'igdb'
        and not (
          estimate.evidence @>
            '{"duplicate_provider_id_validated": true}'::jsonb
        )
    ) as igdb_links_blocked_by_reuse
  from public.game_duration_estimates as estimate
  where estimate.provider in ('hltb', 'igdb')
    and estimate.match_status = 'matched'
    and estimate.provider_game_id is not null
  group by estimate.provider, estimate.provider_game_id
  having count(distinct estimate.steam_app_id) > 1
)
select
  '09_reused_provider_ids_summary'::text as audit_section,
  case when grouping(provider) = 1 then 'ALL_PROVIDERS' else provider end as provider,
  count(*) as reused_provider_ids,
  sum(steam_app_count) as colliding_app_links,
  sum(steam_app_count - 1) as excess_app_links,
  max(steam_app_count) as maximum_apps_for_one_provider_id,
  coalesce(sum(igdb_override_links) filter (where provider = 'igdb'), 0)
    as igdb_links_with_explicit_duplicate_override,
  coalesce(sum(igdb_links_blocked_by_reuse) filter (where provider = 'igdb'), 0)
    as igdb_links_blocked_by_reuse,
  count(*) filter (
    where provider = 'igdb' and igdb_links_blocked_by_reuse > 0
  ) as igdb_reused_ids_with_blocked_link,
  count(*) filter (where provider = 'hltb') as hltb_reuses_requiring_review,
  count(*) filter (
    where provider = 'hltb'
      and not every_hltb_link_validated
  ) as hltb_reuses_with_unvalidated_link
from reused_ids
group by grouping sets ((provider), ())
order by grouping(provider) desc, provider;

with reused_ids as (
  select
    estimate.provider,
    estimate.provider_game_id,
    count(distinct estimate.steam_app_id) as steam_app_count,
    count(distinct nullif(game.developer, '')) as distinct_developers,
    min(game.release_date) as earliest_release,
    max(game.release_date) as latest_release,
    bool_and(
      estimate.provider <> 'hltb'
      or (
        estimate.evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
            and estimate.evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            estimate.evidence ->> 'verification_method' in (
              'safe_exact_title',
              'safe_exact_alias'
            )
            and estimate.evidence ->> 'verification_tier' in (
              'exact_title',
              'mixed_script_title'
            )
          )
        )
      )
    ) as every_hltb_link_validated,
    count(*) filter (
      where estimate.provider = 'igdb'
        and estimate.evidence @>
          '{"duplicate_provider_id_validated": true}'::jsonb
    ) as igdb_override_links,
    count(*) filter (
      where estimate.provider = 'igdb'
        and not (
          estimate.evidence @>
            '{"duplicate_provider_id_validated": true}'::jsonb
        )
    ) as igdb_links_blocked_by_reuse,
    string_agg(estimate.steam_app_id::text, ', ' order by estimate.steam_app_id) as steam_appids,
    string_agg(coalesce(game.name, '<missing catalogue row>'), ' | ' order by estimate.steam_app_id)
      as game_names
  from public.game_duration_estimates as estimate
  left join public.catalog_games as game
    on game.steam_appid = estimate.steam_app_id
  where estimate.provider in ('hltb', 'igdb')
    and estimate.match_status = 'matched'
    and estimate.provider_game_id is not null
  group by estimate.provider, estimate.provider_game_id
  having count(distinct estimate.steam_app_id) > 1
)
select
  '09_reused_provider_ids_examples'::text as audit_section,
  provider,
  provider_game_id,
  steam_app_count,
  distinct_developers,
  earliest_release,
  latest_release,
  every_hltb_link_validated,
  igdb_override_links,
  igdb_links_blocked_by_reuse,
  case
    when provider = 'hltb' then 'review_hltb_identity_reuse'
    when igdb_links_blocked_by_reuse = 0 then 'igdb_reuse_explicitly_validated'
    when igdb_override_links > 0 then 'igdb_reuse_partially_blocked'
    else 'igdb_reuse_blocked'
  end as policy_result,
  steam_appids,
  game_names
from reused_ids
order by
  case
    when provider = 'hltb' then 0
    when igdb_links_blocked_by_reuse > 0 then 1
    else 2
  end,
  steam_app_count desc,
  provider,
  provider_game_id
limit 50;

commit;
