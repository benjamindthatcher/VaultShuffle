# Reviewed isolated-target followups

Target: **VaultShuffle2**, `vbjtbwelnhbbdfrqczyf`. This packet must never run against the original database. It applies six prepared migrations in one transaction, preserving the five already-applied files and their ledger entries.

[Executable packet](v2-rehearsal-followups-20260929.sql), SHA256 `5891626a8749997f2d418f4f33347d8400f78b2be37f31f7e39ff853d5b528bc`.

The changes are the existing bounded manual-session renewal function; exact recommendation numeric precision; preservation of unknown-subject family observations and rollback compatibility settings; owner-protected Wishlist; HLTB-only duration cleanup/constraints/operator resolver; and three nullable current catalogue fields. The packet refuses a wrong marker, changed ledger bytes, schema drift or populated migration data tables. Existing support policy seed data remains intact. Final schema and eleven ledger entries are checked before commit.

Access changes: the existing `vault_app` role gains execute on bounded manual-session renewal and SELECT/INSERT/DELETE on its own Wishlist through forced RLS. Browser/public/worker access is revoked; no new login, session secret, provider worker or external exposure is created. These are the only added runtime capabilities in the packet.

Local validation: replayed the exact five-migration baseline and live stored ledger, applied the packet successfully, then reran it and verified refusal without changes. The final schema fingerprint is `34ea7355f8d2ee4881e6907b310bae88f9d2ab198d99463acfb7a72f0c65e8bc`.

Status: **applied to the isolated rehearsal target on 30 September after explicit user approval**. All eleven ledger entries and the final fingerprint match; the target still contains zero real accounts/games/Library rows. Owner-protected Wishlist SELECT/INSERT/DELETE and forced RLS are verified; runtime UPDATE and anonymous SELECT remain denied. See `database/v2/target-audit-20260930.json`. It copies no production rows and performs no production switch. HLTB cleanup can only run after the guard proves these rehearsal data tables empty. Original migration comments/bytes are retained as historical source, even where they describe earlier preparation status.

Rollback before commit is automatic on any refusal. After successful commit, record application and use an additive correction rather than rewriting immutable migration files. A repeated apply is refused.
