# Vault recommender

Updated 23 September 2026. This describes the code in this checkout. Live learning weights and tables must be checked independently after deployment.

## Draw modes

A guided Vault draw uses Session, Mood, Goal and up to three optional Genres. Completed and Blacklisted games, global exclusions and temporary snoozes are removed before scoring. The selected Genres restrict the pool to games matching at least one selection. Session and Mood rank games; they do not remove them. A collection draw ignores the setup and draws uniformly from that collection. Quick Draw ignores the setup and draws uniformly from its eligible library.

**Something New** keeps games with at most two hours played and at most 10% inferred progress. A game with an unknown or low-confidence duration needs at most half an hour of known playtime. Family-shared playtime is unknown, so an apparently unstarted shared game may enter, but the explanation never calls it unplayed. This goal is eligibility only: Session, Mood, Genres, appeal, per-game verdict and personal taste choose among qualifying games.

**Finish Something** requires a finite game with a credible playthrough estimate of at least two hours, at least one hour played, at least 12% of the estimate played, and at most 25 estimated hours remaining. Low-confidence and missing estimates, unknown personal playtime, and playtime already at or beyond the estimate are excluded. This is an estimate of finishability, not campaign progress. Remaining time is estimated duration minus observed hours. A bounded finish quality supplies 70% of the displayed fit score; Session, Mood and Genres supply the other 30%. Short, Evening and Weekend sessions increasingly tolerate three, six and twelve hours remaining before reducing finish quality. Finalists more than 20 finish-quality points behind the strongest are excluded, including in tiny pools. If there is no close finish, farther finite games up to 25 hours remaining can still appear. If there is no credible finite candidate, the goal has an empty pool rather than inventing a finish. Explanations state the estimated remaining time, hours played and estimated playthrough length, and say actual story progress may differ.

**Surprise Me** applies neither goal restriction. It keeps the middle of the library available and uses the other selected context and quality signals.

A guided pool is scored before its 64-game deck is assembled. The deck rotates deferred rerolls behind fresh games. The finalist window ordinarily holds up to ten games while preserving exact ties; Finish Something applies its finish-quality gate first. The final draw uses softmax temperature 15. Per-game appeal and population verdict affect close choices, while personal learned preference only reweights finalists and never changes eligibility or the candidate set.

## Learning signals

The nightly `/api/cron/genre-preferences` worker rebuilds user genre preferences, global genre preferences and `game_preference_globals` from recent Vault draw events, current Library Blacklist/Complete timestamps, active Playing Next commitments, and ownership playtime. Draw events and Library outcomes decay with a 60-day half-life in a 180-day window. A Library outcome is separate from the immediate draw choice and each user's latest Blacklist/Complete outcome for a game is the only one used. At most 50 Library Blacklist/Complete outcomes from one user are counted per rebuild. Ownership playtime is weaker inferred evidence, including a quarter-unit negative for an unplayed owner and half-unit maximum for a played owner.

The current draw event meanings are:

| Action | Learning | Analytics |
| --- | --- | --- |
| Pick another | `drew_again` on the previous draw, weak negative unless a stated opinion or reroll reason exists | `vault_pick_another` |
| Reroll reason | `reroll_not_interested` is a stronger negative; `reroll_wrong_mood` only affects that mood; other reasons suppress the bare reroll but do not vote on genre | Reason event in draw history |
| Play later / Save for later | `pinned`, positive Playing Next commitment after persistence | `vault_save_later`, Playing Next added |
| Play now, Steam client | `opened_on_steam`, strongest immediate positive | `vault_play_now`, `vault_pick_launched`, Playing Next launch where applicable |
| Play now, store page | `play_now_intent`, positive intent without claiming launch | `vault_play_now` with store target |
| Blacklist | `user_games.slept_at`, strong negative Library outcome | Game status changed / Playing Next removed |
| Complete | `user_games.completed_at`, bounded positive outcome | Game status changed / Playing Next completed |

Play now may also add the game to Playing Next. For one draw, `opened_on_steam` takes precedence over `play_now_intent`, which takes precedence over `pinned`, which takes precedence over a historical `liked` event. Duplicate event types on one draw count once. An active Playing Next row is also learned for commitments made outside Vault; if a draw event was recorded within five minutes of the pin, the state signal is skipped. Removing or replacing a Playing Next slot does not create a second negative vote. Historical Like, Dislike and Hidden for session events remain learnable while in the window, but current result actions do not depend on them. `decision:keep` had no current source and was removed from the weight table migration; `decision:pin` now tunes active Playing Next state. The storage event name `pinned` still represents the user-facing Playing Next commitment.

`algorithm_weights` holds the live strengths; built-in defaults keep the rebuild working if the table cannot be read. Per-game verdicts are shrunk toward the population baseline with an eight-unit prior. Verdict points are capped at +6 and -10; popularity adds 0 to +8 based on total playtime between 500 and 50,000 hours. No verdict row has no effect. These point caps were retained after the live distribution check below; explicit goal eligibility and contextual fit remain stronger.

## Live audit before this change

Read-only checks on 23 September 2026 found 24,986 per-game rows, last refreshed at 06:20 UTC, and 35,526 user genre rows across 450 users. The per-game total was 31,644.9 positive units out of 155,948.4 total, with 3,734,868 owner-hours. There were 9,524 game rows below one unit of evidence, 3,848 with at least ten and 501 with at least fifty. Only 900 passed the 500-hour popularity floor and five reached its 50,000-hour ceiling. Across 390,447 ownership rows with a catalogue AppID, 205,704 were unplayed and 184,743 played.

Representative extremes with at least 20 evidence units: Conan Exiles - Public Beta Client had 0/44.7 and 2 hours; For Honor - Public Test had 0/40.3 and 0 hours; Baldur's Gate 3 had 164.1/198.7 and 37,301 hours; ELDEN RING had 145.8/176.5 and 29,238 hours. Against the overall live baseline, their verdict plus popularity terms are approximately -6.0, -5.8, +11.9 and +11.4 points, or 0.67×, 0.68×, 2.20× and 2.14× the odds of equally fitting neutral games before other appeal terms. One negative unit is only about -0.5 points after shrinkage. These are useful directional checks, not evidence that every individual recommendation is correct. Contextual tests verify that a popular but distant finish cannot displace a near finish.

The live draw-event table still showed only 27 `drew_again` events, latest on 24 August, despite later draws. It had 88 `opened_on_steam` and 46 `pinned` events. This confirms the missing modern reroll write. The new `play_now_intent` event and weight are code and migration changes; their live arrival must be verified after deployment and a real store-page action.

### Approved rebuild, 23 September 2026

The live migration added `play_now_intent` to the event constraint and the 2.5/2.5 weight, and removed inert `decision:keep`. The updated worker then succeeded from 13:01:37 to 13:02:43 UTC. It processed 2,882 draws, 525 draw events (489 scored after precedence), 10,233 Library Blacklist/Complete outcomes, 68 active Playing Next commitments, and 388,575 ownership rows. It wrote 35,627 user genre rows, 1,022 global genre rows and 24,986 per-game rows; all three tables had zero rows older than their latest rebuild timestamp. The bootstrap verdict loader returned `[0, 44.619, 2]` for the Conan beta client and `[165.728, 200.303, 37300.5]` for Baldur's Gate 3; an unknown AppID returned no tuple.

No new `drew_again` or `play_now_intent` events were present immediately after the rebuild. The application code that writes them has not been deployed, so modern event arrival and the production site's authenticated bootstrap still require post-deployment checks. The deployed nightly worker also needs the new code before its next run, otherwise it will rebuild with the old signal taxonomy.

## Operational checks

The rebuild reads paged draw and Library outcome data, walks ownership rows by primary-key cursor, upserts fresh preference rows and sweeps stale rows by rebuild timestamp. A failed preference read returns a neutral fallback so Vault draws continue. After deploying the event path and applying the weight migration, run the learning worker, check its summary and duration in `metadata_worker_runs`, compare all three preference tables' `updated_at` values and stale-row counts, inspect bootstrap verdict tuples, then check fresh `drew_again` and `play_now_intent` events after real actions. The PostHog per-draw genre-learning experiment and `preference_rows` telemetry can then be interpreted against the refreshed tables.

## Release review, 23 September 2026

Validation of the isolated Vault release completed: 504 unit tests and all 24 browser tests passed, as did typecheck and the production build. The larger mixed checkout previously passed 542 unit tests. The Playing Next browser tests now assert the actual event request and draw ID for saved commitments, desktop launches, mobile store intent and rerolls. Failed saves emit no positive event. Full lint on the isolated release passed with no errors and 23 existing warnings.

The live tables were checked again after the pause: 35,627 user genre rows, 1,022 global genre rows and 24,986 per-game rows still have the approved rebuild timestamps, with no stale rows. New `drew_again` and `play_now_intent` counts since the rebuild remain zero.

The implementation and local action flow are validated. Release completion still requires deploying the application and worker together, checking an authenticated production bootstrap, and observing the modern events from real production actions. The approved release contains only the Vault changes; unrelated feature work stays in the original checkout. At the time of this pre-deployment review, production event verification remained the final release gate.

Remaining data limitations are intrinsic: Steam playtime includes replaying and idle time, duration estimates do not measure campaign progress, and family-shared personal playtime may be unknown. Explanations use estimates and conservative eligibility accordingly.


## Polish and learning review, 25 September 2026

This is a source-code review of the current checkout, not a new inspection of production tables. The earlier production observations above retain their original dates. The selection architecture and numeric learning weights are unchanged.

### Signals and decisions

| Signal | Current interpretation and review decision |
| --- | --- |
| Play now | Steam-client launch is 3 positive units; a store visit is 2.5 units of intent. Neither proves actual playtime. Preserve the distinction. |
| Save for later / Playing Next | 2 positive units, weaker than launch. Active commitments outside Vault are included; events within five minutes of a commitment suppress a duplicate state vote. |
| Remove / replace Playing Next | Frees a slot without a new negative vote. The earlier expression of interest remains historical evidence. |
| Reroll | 1 negative unit per distinct draw, ignored if the same draw has a stronger opinion or reroll reason. Repeated rerolls accumulate gradually; duplicates on the same draw do not. |
| Explicit reroll feedback | Not interested contributes 2 negative units; wrong mood contributes 1 only to that mood, not a per-game verdict. Too long, played enough and not tonight suppress the bare reroll without claiming genre dislike. |
| Blacklist | Removes eligibility immediately; the persisted Library outcome supplies 4 negative units. Its automatic replacement does not also record a bare reroll or a second historical blacklist event. Undo clears the outcome timestamp, so it disappears at the next rebuild. |
| Complete | 1 positive unit, deliberately below a save. The prior audit found bulk historical completions dominating draw decisions; increasing this solely because completion sounds stronger would recreate that bias. Keep the cap pending new outcome evidence. |
| Launch after saving | The launch supersedes the save on the same draw; Playing Next baseline progress remains intact. Later ownership-playtime evidence is a separate, weaker signal. |
| Dwell | No dwell signal is consumed by this worker. Do not invent one or equate leaving a card onscreen with acceptance. |
| Historical Like / Dislike | Still consumed within the learning window; no retired controls are reintroduced. |

Genre preferences are personal, shrunk toward a baseline, and bounded to ±8 points. Population genre priors help sparse users. Per-game verdicts are population-level, with an eight-unit prior and bounded verdict/popularity terms; there is no separate personal game-verdict model to infer from these tables. Draw and Library evidence decays with a 60-day half-life over 180 days, and at most 50 Library outcomes per user are counted. Ownership playtime is a current snapshot rather than a timestamped event stream. Family ownership rows are excluded from inferred playtime evidence; deliberate family-library actions remain usable.

Learned genre preference only changes finalist probabilities in the experiment's test arm. It does not change eligibility or the finalist set. Quick Draw and collection draws remain uniform. Legacy `pinned` and `sleep` storage names retain their explicit Playing Next and Blacklist meanings. Live `algorithm_weights` can override the defaults above; this review did not read or change them.

### Evidence-based fixes

Personal-taste explanations now consume structured genre/mood evidence from the scorer. They no longer search display strings or depend on the four-item legacy reason list. Population-only evidence cannot be called personal taste, and the control arm does not explain a preference term it did not use.

Result reasons preserve family provenance, then Goal, Session, Mood, selected Genres, revisit evidence, personal taste and positive appeal, with at most four tiles. Session copy distinguishes short/evening/weekend and uses supported sessionability. Revisit copy preserves date precision; family explanations never infer personal progress or recency. Divisive appeal still penalizes selection but does not appear as a positive reason. Technical fit and pool position moved to Vault Lens; the result shows only its qualitative match label.

Blacklist on the result removes eligibility optimistically, removes Playing Next if necessary, and starts another pick without waiting for persistence. Undo waits behind the pending blacklist write and restores the previous status and available Playing Next slot. Failed writes reconcile through the existing mutation queue and show a recoverable error. History persistence runs independently of rendering; follow-up events capture the pending draw ID so rapid rerolls remain correctly attributed. Quick Draw's result explicitly says setup was not used, and rerolling that result remains a Quick Draw.

The result retains four distinct actions: launch/store, save/status, reroll and blacklist. Mobile stacks them in that order. The store fallback remains named “View on Steam” because it cannot launch a client. Undo and error notices stack above the bottom analytics notice. The setup retains three editable steps, with consistent selected values and completed indicators.


### Validation of this polish pass

553 unit tests passed. The full 37-test Chromium browser suite passed, covering Vault, Playing Next, Library, navigation and Wishlist. After the last attribution/count fixes, all 14 Vault/Playing Next checks passed again, followed by a focused regression proving that a launch during reroll animation still belongs to the visible game. The production build and typecheck passed. Source lint excluding unrelated `.claude` worktrees passed with zero errors and 23 existing warnings; plain `npm run lint` also scans generated files in those nested worktrees and fails there.

Browser coverage includes guest guided/Quick Draw, saved-state behavior, launch versus store intent, replacement/removal, failed saves, delayed Blacklist persistence, immediate Undo, repeated rerolls across a cycle, final-game empty state, slow history, mobile action order, mobile scroll stability and no horizontal overflow. Runtime error assertions passed. Desktop (1280×720) and mobile (390×844) result screenshots were inspected; Playwright was used because the Browser plugin was unavailable. Live Steam launch, production event arrival and live learning-table freshness were not exercised by the mocked signed-in browser flows. No deployment or database changes were made in this pass.
