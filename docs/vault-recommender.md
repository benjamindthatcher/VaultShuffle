# Vault recommender

How the learned genre term works, and what is still worth doing to it.

Written 2026-08-18. P1 and P2 are now done; what remains is recorded below.

## How it works today

`vault_draw_events` records what the user did with a pick. A nightly worker
(`/api/cron/genre-preferences`, 06:00, after the catalogue refresh it reads
genres from) turns those events into `user_genre_preferences`, keyed on
`(user_id, genre, context_mood)`.

- Signals are weighted: opening on Steam and liking count double, pinning once;
  disliking, sleeping and "not interested" count against. Reroll reasons that
  describe something other than genre (`too_long`, `not_tonight`,
  `played_enough`) contribute nothing, and a reason supersedes the bare
  `drew_again` for its draw.
- Every signal also updates a `__baseline__` row holding the user's own overall
  rate in that context. Genres are shrunk toward that baseline, and the baseline
  is itself shrunk toward a population rate in `genre_preference_globals`, so a
  user with no history starts on shared taste rather than on nothing.
- Weights decay with a 60-day half-life inside a 180-day window.
- At draw time each game gets `preferencePoints` in ±8, averaged across its
  top-level genres and weighted by inverse genre frequency.
- Genres are compared to the baseline in **log-odds**, squashed through `tanh`.
  Proportional comparison saturates when a baseline is near zero, which flattens
  every genre onto the cap and destroys the differences the softmax acts on.

The term is **not** part of the score used for ranking. The pool is sorted by fit
and truncated twice (32-game deck, ~13-game finalist slice), so a term inside the
ranking would decide which games can be drawn at all. `preferencePoints` is
applied only in `drawVaultGame`'s softmax, where it can reweight but never gate.

Because that softmax normalises by `maxScore` before exponentiating, it is
shift-invariant: a constant offset across all candidates cancels out. Only the
*spread* of `preferencePoints` affects selection. This is why the current
all-negative values (see P1.2) are not in themselves a problem.

The experiment arm is drawn **per draw**, not per user, and rides on each event
as a property. Quick Draw is uniform by design and takes no part in it.

---

## P1 — currently prevents the system from working

### 1. Draw retention — RESOLVED

`trim_vault_draw_history` capped `vault_draws` at 50 per user and
`vault_draw_events` cascades with it, so the most active user — already at
exactly 50 — destroyed an old draw and its events on every new one.

The cap is now 500. The history UI limits itself to 50 independently, so nothing
user-facing changed. Raising retention only ever keeps more, which is the safe
direction for a change to a deletion rule.

Still open: the learner remains downstream of a table whose retention exists for
a different purpose. Decoupling it — appending signals to a durable ledger at
event time — would remove the coupling entirely, at the cost of the idempotent
full rebuild that currently makes double-counting impossible. Not worth it while
500 is comfortably above real usage.

### 2. No positive signal exists yet, and several paths are untested in production

At time of writing: 20 events total, of which 18 are bare `drew_again`, and
**zero** are `liked`, `opened_on_steam` or any `reroll_*` reason.

Consequences:

- Every genre currently scores negative. Harmless today (softmax is
  shift-invariant, above) but it means the term is doing almost nothing.
- The reroll-reason logic and the positive-signal paths have unit tests but have
  never run against real input.
- Both experiment tiles will read empty until real launches land.

Nothing to build here — it needs usage. But do not read the experiment tiles as
evidence of anything until positives exist.

---

## P2 — correctness and robustness

### 3. Baseline anchoring — RESOLVED

User baselines are now shrunk toward a population rate held in
`genre_preference_globals`, aggregated across all users by the same nightly
rebuild. 0.5 survives only as the root prior that the *population* is measured
against; no individual is judged by it any more.

### 4. The nightly rebuild skips its stale sweep on an empty read

`rebuildGenrePreferences` returns early when there are no draws or no events
(`lib/genre-preference-worker.ts:107,112`), before the sweep that deletes stale
rows. Deliberate — it fails safe, keeping old preferences rather than wiping them
on a transient empty read — but it does mean preferences never clear if all
activity genuinely disappears. Revisit if that case ever becomes real.

### 5. Cold start — RESOLVED

The population's genre rates are transferred onto a user's own baseline
additively, so a user with no history lands exactly on the population rate and is
shrunk away from it as soon as they generate anything themselves. A new account
now gets a useful ordering on day one.

### 6. Silent inertness — RESOLVED

`vault_draw_requested` now carries `preference_rows`. A recommender that loaded
nothing and one that is working are no longer indistinguishable from the outside:
if that number is flat zero, the feature is inert regardless of why.

`listGenrePreferences` still swallows its errors on purpose — a draw must not
fail because a preference could not be read — but the failure is now visible.

## P3 — genuine improvements, not yet worth the cost

### 7. Learn contrastively from deck composition

The real signal in a draw is "picked C from a deck that also contained A and B" —
a ranking observation worth far more than three independent binary labels, which
matters enormously at these volumes. The right model is a conditional logit over
the deck.

The data collection half is now done: `vault_draws.finalist_appids` records the
exact candidate set each pick was chosen from, in both arms, because a model
built later cannot reconstruct a choice set that was never captured.

The model itself is still not worth building at these volumes. Revisit once there
is a meaningful number of draws carrying `finalist_appids` *and* a positive class
to rank against.

### 8. Genre keys are coarse

Top-level genres were the right call at this data volume — the full eight-tag list
spreads signal too thin to accumulate. Revisit once there is materially more data;
sub-genres are where the interesting preferences actually live.

---

## Reading the experiment

Two tiles on [Product Funnels](https://eu.posthog.com/project/223890/dashboard/902642):

- **Experiment · genre learning vs control (draw → launch)** — the headline rate.
- **Experiment · rerolls before launch, by arm** — mean `reroll_index` on
  `vault_pick_launched`. This is the sensitive one: a continuous metric needs far
  fewer samples than a binary rate. Lower is better.
- **Health · is the recommender actually loaded?** — mean `preference_rows` on
  `vault_draw_requested`. Flat zero means the term is inert whatever the cause.

Expect the binary rate to be uninformative for a long time. Per-draw
randomisation removes between-user variance, which is the single biggest win
available at this user count, but it cannot manufacture events that do not exist.

Kill switch: PostHog flag `vault-genre-learning` (id 253726). Turning it off puts
every draw in control.

---

## Infrastructure risk worth addressing

### The schema ledger and the repo disagree

Corrected 2026-08-19 — an earlier version of this file said there was no
migration tooling. That is wrong, and the truth is more awkward.

- Production **does** track migrations: `supabase_migrations.schema_migrations`
  holds 83 applied entries, the most recent `20260814172252`.
- The repo **deliberately** does not. The files were removed in `e287bba`
  ("Remove Supabase migration history", 2026-08-12), with no stated reason. The
  checkout is still linked (`supabase/.temp/project-ref`).
- Everything this feature changed was applied straight through the Management
  API, so it is in neither place — not in the repo, and not in the ledger.

So the ledger no longer describes the live schema either. `supabase db diff`,
`db push` and especially `db reset` will all reason from a picture that is
missing today's objects, which is a sharper hazard than simply having no
migrations at all.

This needs a decision rather than a unilateral fix, because reinstating
migrations would reverse a deliberate choice:

1. **Bring the schema back under migrations.** Baseline the current live schema
   as one migration, mark it applied, and require future changes to go through
   it. Highest effort, removes the class of problem.
2. **Keep applying directly and treat this file as the record.** Cheap and
   honest, but every schema change depends on someone remembering to write it
   down — which is exactly the failure that produced this note.
3. **Drop the ledger too**, so nothing implies a workflow that is not followed.
   Removes the trap without adding process.

Two footguns worth keeping regardless of the choice, both of which cost a failed
production run today:

- A new table needs explicit grants. RLS-enabled with no policies is the
  convention here (everything goes through the service role), but the service
  role still needs table privileges — creating the table is not enough.
- Changing an RPC's signature means drop-and-create, not `create or replace`.
  Doing both in one statement batch keeps it atomic, so there is no window where
  the function does not exist.

Applied to production 2026-08-18, recorded here because nothing else records it:

```sql
create table public.user_genre_preferences (
  user_id uuid not null references public.app_users(id) on delete cascade,
  genre text not null,
  context_mood text not null default 'any',
  positive double precision not null default 0 check (positive >= 0),
  total double precision not null default 0 check (total >= 0),
  updated_at timestamptz not null default now(),
  constraint user_genre_preferences_pkey primary key (user_id, genre, context_mood),
  constraint user_genre_preferences_context_mood_check
    check (context_mood = any (array['any','brain-off','chill','intense'])),
  constraint user_genre_preferences_positive_lte_total check (positive <= total)
);

alter table public.user_genre_preferences enable row level security;
create index user_genre_preferences_user_idx on public.user_genre_preferences (user_id);
grant select, insert, update, delete on public.user_genre_preferences to service_role;


-- Population rates, and the two changes that keep the learner fed.
create table public.genre_preference_globals (
  genre text not null,
  context_mood text not null default 'any',
  positive double precision not null default 0 check (positive >= 0),
  total double precision not null default 0 check (total >= 0),
  updated_at timestamptz not null default now(),
  constraint genre_preference_globals_pkey primary key (genre, context_mood),
  constraint genre_preference_globals_context_mood_check
    check (context_mood = any (array['any','brain-off','chill','intense'])),
  constraint genre_preference_globals_positive_lte_total check (positive <= total)
);
alter table public.genre_preference_globals enable row level security;
grant select, insert, update, delete on public.genre_preference_globals to service_role;

-- The choice set each pick was made from.
alter table public.vault_draws add column finalist_appids bigint[];

-- trim_vault_draw_history: offset raised 50 -> 500.
-- record_user_vault_draw: gained p_finalist_appids bigint[] default null,
--   applied as a single drop+create batch so there was no window without it.
```

Adopting Supabase migrations properly is the real fix. Until then, every schema
change should be appended to a file like this one.

---

## Unrelated work still outstanding

Carried forward, not touched by this feature:

- **872 games in `duration_status = 'review_required'`.** IGDB is exhausted.
  `npm run duration:hltb` needs the service-role key, which Vercel marks
  Sensitive, so it must be run locally.
- **4–7 games failing every catalogue-metadata run — DIAGNOSED AND FIXED
  2026-08-19.** Not delisted, which was the standing guess: Steam returns success
  for all seven. `catalog_games` has a `steam_type = 'game'` check constraint,
  and the seven are `advertising`, `mod`, three `demo` and two `dlc`. They came in
  as user imports, were stubbed as `'game'` (the only permitted value), and every
  refresh tried to write the true type, violated the constraint, and was recorded
  as a transient failure — 83 attempts on the oldest. `queue_stale_catalogue_metadata`
  then flipped any rejection back to `pending`, so nothing could ever settle.

  It stayed invisible for a month because of a second bug: Supabase reports
  failures as plain objects, so `error instanceof Error` was false and the real
  message was replaced with "Unknown catalogue ingestion error" every time. The
  queue recorded eighty failures without once saying what went wrong.

  **Still a decision to make.** The seven are resolved but deliberately *not*
  quarantined, so nobody's library changed. Two of them — `X3: Albion Prelude`
  (201310) and `The Vanishing of Ethan Carter Redux` (400430) — are standalone
  and genuinely playable despite Steam labelling them `dlc`, and `tModLoader`
  (1281930) is how people launch modded Terraria. The three demos and the
  `advertising` entry are much weaker candidates for a Vault draw. Quarantining
  any of them hides them from the users who own them, which is a product call:

  ```sql
  -- hide one of them, per AppID
  insert into catalog_game_quarantine (steam_appid, name, steam_type, reason, matched_rule)
  values (3559900, 'Voidling Bound Demo', 'demo', 'Demos are not Vault picks.', 'manual:excluded');
  ```
- **Platform/Deck backfill**, ~2,100 of 2,279 remaining at 80/run. Mac and Steam
  Deck modes stay near-useless until it finishes, since unknown Deck
  compatibility is excluded by design.
- **`refreshNightlyMetadata` gives library refresh a hard 90s budget** and defers
  the rest. `librariesDeferred` was 0 at 8 users; it will climb.
- **Visual standardisation**, parked at the user's call. Spacing now lives once
  on `.appContent` and colours map to `globals.css` tokens, but panels still read
  as inconsistent. Verify against the rendered page, never by reading CSS.
