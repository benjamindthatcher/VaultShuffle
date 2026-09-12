# M3 capability precedence and legacy evidence

Coordinator ruling, 9 September 2026. This resolves D-IDN-3 for the measured
population and corrects a semantic assumption in the readiness proposal.

`lib/games.ts:304` writes the latest import visibility to **app_accounts**.
`lib/session-payload.ts:29` reads playtime visibility from **app_accounts**.
The identity migration initially copied the old app_users values into that
neutral account table; later account writes do not mirror back to app_users.
The root's aggregate audit found 183 value disagreements, all accompanied by an
account-side dated observation and no profile-side date. Another 88 accounts
have a newer account-side date. No profile is newer or exclusively dated, and
there are no equal-time conflicting triples. Exact counts/SQL are in
`database/v2/source-visibility-audit-20260909.{json,sql}`.

Use the account-side tuple (three raw flags, checked time and games seen) as the
legacy authoritative observation, preserving its provenance. Do not select each
field independently from whichever side is non-null. Preserve differing profile
evidence with source attribution in the migration reconciliation evidence until
reviewed; do not silently erase it. The real export must rerun the precedence
checks. A profile-newer, profile-only-dated or equal-time conflicting case is a
new exception to reconcile, not permission to change precedence automatically.

**False is not proof of hidden.** `lib/steam-owned-games.ts:117` computes
playtimeVisible with `some(hours_played > 0)` and lastPlayedVisible with
`some(last_played_at)`. A completely visible zero-playtime library therefore
produces false. `libraryVisible` is `games.length > 0`, which also does not
distinguish empty from private. These are availability heuristics, not explicit
provider privacy assertions. Preserve the raw boolean tuple, observed time and
games count as versioned legacy evidence. For the v2 capability projection,
true may establish visible; false and NULL project to unknown absent separate
validated privacy evidence. Do not infer status=private from these booleans.
Treat any legacy success/failure classification as unknown unless its provenance
supports a stronger value. This is a deliberate correction supported by current
writer code; it preserves every original observation while avoiding a fabricated
privacy conclusion.

Physical contract impact: provide sparse, bounded legacy capability evidence
separate from the compact library. Manifest/transform impact: exact account-side
tuple precedence and explicit boolean-to-capability projection, with differing
profile tuple retained for reconciliation. Security: no new broad reader or
verification privilege. Tests: true/false/NULL; all-zero visible library; absent
last-played timestamps; source tuple conflicts and timestamp precedence; actual
snapshot recheck. M4 must retain the raw evidence for diagnosis while showing
the v2 capability semantics, rather than telling users that an unknown field is
necessarily private.
