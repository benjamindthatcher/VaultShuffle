-- ============================================================================
-- M3 source probes P01-P04  --  readiness section 10, items 1 to 4
-- COUNT-ONLY. Read-only. NOT RUN in this batch; proposed for coordinator review.
--
-- No raw rows. No personal data. No session or token digests. No emails.
-- vault.secrets is never read.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- P01  The two-account discrepancy.
--
-- Plan section 2 records 198 manual accounts and 196 public.manual_steam_profiles rows.
-- Promotion cannot explain it: promotion sets account_type = 'steam' and THEN
-- deletes the profile (20260830151421_secure_manual_profiles.sql:345, :373).
-- The disposition of those accounts depends on whether they own data.
--
-- Returns counts and child-row totals only. No account id, no display name.
-- ----------------------------------------------------------------------------

-- P01a  How large is the discrepancy, in both directions?
select
  count(*) filter (where a.account_type = 'manual')                as manual_accounts,
  count(*) filter (where a.account_type = 'manual' and p.id is null)
                                                                   as manual_without_profile,
  count(*) filter (where a.account_type = 'steam'  and p.id is not null)
                                                                   as steam_with_stale_profile,
  count(*) filter (where a.account_type = 'steam'  and u.id is null)
                                                                   as steam_without_app_user
from public.app_accounts a
left join public.manual_steam_profiles p on p.id = a.id
left join public.app_users            u on u.id = a.id;

-- P01b  Do the profile-less manual accounts own anything?
-- One row per affected account is still count-only in substance, but the account
-- id is identifying, so this aggregates ACROSS them instead.
select
  count(*)                                    as affected_accounts,
  min(a.created_at)                           as earliest_created_at,
  max(a.created_at)                           as latest_created_at,
  coalesce(sum(g.library_rows),   0)          as total_library_rows,
  coalesce(sum(s.session_rows),   0)          as total_session_rows,
  coalesce(sum(c.collection_rows),0)          as total_collection_rows,
  count(*) filter (where coalesce(g.library_rows, 0) = 0
                     and coalesce(c.collection_rows, 0) = 0)
                                              as affected_accounts_with_no_data
from public.app_accounts a
left join public.manual_steam_profiles p on p.id = a.id
left join lateral (
  select count(*) as library_rows from public.user_games ug where ug.user_id = a.id
) g on true
left join lateral (
  select count(*) as session_rows from public.manual_profile_sessions ms where ms.profile_id = a.id
) s on true
left join lateral (
  select count(*) as collection_rows from public.collections cl where cl.user_id = a.id
) c on true
where a.account_type = 'manual'
  and p.id is null;

-- P01c  Can one account hold BOTH profile kinds?  readiness 14.3
-- app.steam_profiles.account_id is the primary key (M1:108), so v2 permits only
-- one profile per account. This is a plausible explanation for the discrepancy.
select count(*) as accounts_with_both_profile_kinds
from public.app_accounts a
join public.app_users             u on u.id = a.id
join public.manual_steam_profiles p on p.id = a.id;


-- P02 is deliberately separated into `platform-optional.sql`. Platform
-- relations are outside the recorded public inventory and their presence
-- varies by project. The platform runner checks each required relation/column
-- with `to_regclass` and emits an explicit ABSENT result before attempting its
-- object-specific query. Keeping those statements out of this file means the
-- public probe bundle compiles against the exact 44-relation fixture without
-- assuming auth, cron, net, storage or migration-ledger objects exist.


-- ----------------------------------------------------------------------------
-- P03  Existing CLI authentication.
--
-- This is NOT primarily a SQL question, and the SQL part is catalogue-only.
-- The coordinator has already observed `cli_login_postgres` on the source:
-- LOGIN true, SUPERUSER false, BYPASSRLS false, rolvaliduntil expired
-- 2026-09-03. That is EVIDENCE FOR INVESTIGATION, not authorization to refresh,
-- provision, grant, reset or otherwise mutate it.
--
-- The query below only re-reads catalogue attributes. It creates nothing,
-- grants nothing and alters nothing.
-- ----------------------------------------------------------------------------

select
  rolname,
  rolcanlogin,
  rolsuper,
  rolbypassrls,
  rolcreaterole,
  rolvaliduntil,
  (rolvaliduntil is not null and rolvaliduntil < now()) as validity_expired
from pg_roles
where rolname in ('postgres', 'cli_login_postgres', 'vault_app', 'vault_worker')
order by rolname;

-- The remaining part of P03 -- whether the installed CLI offers a PROVEN
-- single-snapshot stream rather than Management API querying, and whether an
-- existing authenticated path reaches the source without mutating a source
-- role -- cannot be answered by SQL and is not attempted here.


-- ----------------------------------------------------------------------------
-- P04  Live routine, view, trigger and grant metadata.
--
-- readiness 2.1 is the proof this matters: the LIVE public.user_games_with_catalog
-- still publishes `rating` and `priority`, columns that no longer exist on live
-- public.user_games, so the view body was rebuilt remotely and DIFFERS from
-- supabase/migrations/20260901193000_share_a_family_library.sql:289.
-- `catalog_user_imports` is the other known case of a stale repository body.
--
-- These return metadata fingerprints and bounded credential-word indicators;
-- definition text is never printed. They return no rows from any application
-- table. Any private definition review is handled in a separate protected step.
-- ----------------------------------------------------------------------------

-- P04a  View bodies. Export before writing any v2 read model that mirrors them.
select
  c.relname as view_name,
  length(pg_get_viewdef(c.oid, true)) as definition_length,
  md5(pg_get_viewdef(c.oid, true))    as definition_md5
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
order by c.relname;

-- P04b  Function inventory. Bodies are fetched separately and reviewed, not
-- bulk-printed: `prosrc` can contain a literal credential.
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef                               as is_security_definer,
  l.lanname                                 as language,
  length(p.prosrc)                          as body_length,
  md5(p.prosrc)                             as body_md5,
  (p.prosrc ilike '%key%' or p.prosrc ilike '%secret%'
     or p.prosrc ilike '%token%' or p.prosrc ilike '%authorization%')
                                            as body_mentions_credential_words
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid = p.prolang
where n.nspname = 'public'
order by p.proname;

-- P04c  Triggers. A trigger can enforce or rewrite exactly the values a
-- transform is about to move.
select
  c.relname as table_name,
  t.tgname  as trigger_name,
  t.tgenabled,
  md5(pg_get_triggerdef(t.oid)) as definition_md5
from pg_trigger t
join pg_class c     on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
order by c.relname, t.tgname;

-- P04d  Grants on public relations, so the exporter knows what its credential
-- can actually see. Grantee names are role names, not user data.
select
  table_name,
  grantee,
  string_agg(distinct privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
group by table_name, grantee
order by table_name, grantee;

-- P04e  RLS policy inventory. The count of policies per relation decides
-- whether the exporter's credential can read it at all.
select
  c.relname                                as table_name,
  c.relrowsecurity                         as rls_enabled,
  c.relforcerowsecurity                    as rls_forced,
  count(pol.polname)                       as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy pol on pol.polrelid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
group by c.relname, c.relrowsecurity, c.relforcerowsecurity
order by c.relname;
