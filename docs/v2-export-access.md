# V2 M3 export access: what the production project actually offers

Browser and access subagent - M3-A - 9 September 2026 - branch `codex/v2-architecture`.
Companion to [the M3-A assignment](v2-m3-a-batch.md) and
[the delta checkpoint](v2-m3-a-checkpoint.md).

Scope: read-only inspection of the already signed-in Supabase dashboard for the
production project `pfvblcopcmairdfeqdep`, plus two read-only management metadata
calls (`get_project`, `get_organization`). No state was changed. **This file
records nonsecret facts only.** No password, key, token, session value or
connection string containing a password was read, revealed, copied or stored, and
no user row was accessed.

## Bottom line

There is **no platform-side snapshot-consistent backup or restore path on this
project's plan**. All three dashboard backup surfaces are upgrade offers, not
capabilities. The only snapshot-consistent export available today is a
**client-side logical dump over a direct or session-mode PostgreSQL connection**,
taken inside a single `REPEATABLE READ READ ONLY` transaction - which is exactly
what the M3 exporter is specified to do, and what `pg_dump` does natively.

Access is therefore **not blocked by the platform**. It is blocked only by the
database password, which is not retrievable by anyone (see
[What the user must do themselves](#what-the-user-must-do-themselves)).

## Project identity, version and region

| Fact | Value | Source |
|---|---|---|
| Project ref | `pfvblcopcmairdfeqdep` | dashboard URL |
| Project name | VaultShuffle | dashboard header |
| Branch | `main`, badged `PRODUCTION` | dashboard header |
| Region | `eu-west-1`; dashboard label West EU (Ireland) | `get_project`; run-1 dashboard read |
| PostgreSQL | `17.6.1.127`, engine major `17`, release channel `ga` | `get_project` |
| Status | `ACTIVE_HEALTHY` | `get_project` |
| Organization | `benjamindthatcher` (`ukemjmhuskxyonjmkdud`) | `get_organization` |
| Plan | **free** (`FREE` badge in dashboard header) | `get_organization`; dashboard header |
| Compute | Nano | Database Settings |
| Created | 2026-06-23 | `get_project` |

The server major version is **17**, so any dump client must be **17 or newer**.
A PostgreSQL 16 client will refuse the server version.

## Connection endpoints

All three modes as the Connect dialog names them. Hosts, ports, database and user
are not secrets and are recorded here deliberately. The dialog renders the
password only as the literal placeholder `[YOUR-PASSWORD]`; no real value was
displayed, and none is recorded.

| Mode (dialog name) | Host | Port | Database | User |
|---|---|---|---|---|
| Direct connection | `db.pfvblcopcmairdfeqdep.supabase.co` | `5432` | `postgres` | `postgres` |
| Session pooler | `aws-0-eu-west-1.pooler.supabase.com` | `5432` | `postgres` | `postgres.pfvblcopcmairdfeqdep` |
| Transaction pooler | `aws-0-eu-west-1.pooler.supabase.com` | `6543` | `postgres` | `postgres.pfvblcopcmairdfeqdep` |

Dialog descriptions, quoted:

- Direct connection - "Ideal for applications with persistent and long-lived
  connections such as those running on virtual m[achines]".
- Session pooler - "Only recommended as an alternative to direct connection when
  connecting via an IPv4 network." Its note reads "Only use session pooler on an
  IPv4 network".
- Transaction pooler - "Ideal for stateless applications like serverless functions
  where each interaction with Postgres is b[rief]".

**Direct or session mode are the approved export connection choices; do not use
the transaction pooler (`6543`) for the snapshot.** Coordinator correction of
9 September: this is a workflow decision, not an impossibility claim. A pooled
backend is retained for the duration of an open transaction, so a long
repeatable-read transaction is not categorically impossible under transaction
pooling. What transaction pooling does not give is reliable session state across
statements, prepared statements, or the session-scoped features a dump client
uses, and the mode is documented for brief interactions ("each interaction with
Postgres is brief"). Direct and session mode are chosen because they are the
supported shape for this workflow, not because the alternative cannot hold a
transaction.

### The IPv4/IPv6 constraint

The Connect dialog shows this note on the direct connection:

> Direct connections use IPv6 by default
> Enable the dedicated IPv4 address add-on to connect from IPv4-only networks.

The **dedicated IPv4 address add-on reads `DISABLED`** on this project
(Settings > Add-ons). So `db.pfvblcopcmairdfeqdep.supabase.co` is reachable over
IPv6 only. The session pooler is the documented IPv4 fallback.

Local check on this machine, run without contacting any network (`ifconfig` only,
addresses deliberately not recorded): **three global-unicast IPv6 addresses are
present, all on `en0`**, the physical interface, not on a VPN tunnel. That is a
strong indication the direct connection is usable from here.

**Not verified:** no connection, TCP probe or DNS lookup against production was
performed, per the batch's no-remote-contact constraint. Actual IPv6 reachability
to Supabase from this host remains untested. The exporter should attempt direct
first and fall back to the session pooler on failure, rather than assuming either.

## Network and SSL posture

| Setting | State as shown |
|---|---|
| Network restrictions | "Your database can be accessed by all IP addresses" - no allowlist configured, nothing to remove before an export |
| Network bans | "There are no banned IP addresses for your project" |
| Enforce SSL on incoming connections | **OFF** (toggle unset; label "Reject non-SSL connections to your database") |
| SSL certificate | A project certificate is offered for download. **Not downloaded.** |
| Connection logging | "Log connections" and "Log disconnections" both present as settings |
| Pool size | Default 15, "based on your compute size of Nano" |
| Max client connections | Fixed at 200 on Nano, "cannot be changed" |

Because **the server does not enforce SSL**, TLS is entirely the client's
responsibility. The exporter must require and verify it itself
(`sslmode=verify-full` with a pinned root, not `require`, and never `prefer`).
A non-TLS connection to this database would currently succeed silently, which is
precisely the failure mode to design against.

## Backup capability on this plan

Every backup surface on this project is an upgrade offer. Verbatim:

| Surface | State | Exact dashboard text |
|---|---|---|
| Scheduled backups | **Not available** | "Free Plan does not include project backups." / "Upgrade to the Pro Plan for up to 7 days of scheduled backups." |
| Point in time recovery | **Not available**, and `DISABLED` as an add-on | "Point in Time Recovery is a Pro Plan add-on" / "Roll back your database to a specific second. Starts at $100/month. Pro Plan already includes daily backups at no extra cost." |
| Restore to new project (BETA) | **Not available** | "Restore to a new project requires Pro Plan and above" / "To restore to a new project, you need to upgrade to a Pro Plan and have physical backups enabled." |

The Scheduled backups tab also states the general behaviour - "Projects are backed
up daily around midnight of your project's region and can be restored at any time"
- but that sentence describes the paid capability, immediately followed by the
Free Plan exclusion. **There is no existing backup artefact to download, and no
restore point to clone from.** There is no downloadable-dump feature anywhere in
this dashboard on this plan.

Add-ons page, for completeness: Dedicated IPv4 address `DISABLED`, Point in time
recovery `DISABLED`, Custom domain `DISABLED`.

## The documented consistent-dump path, and what it requires

With no platform snapshot available, the consistent path is a logical dump the
client takes itself:

1. **`pg_dump` 17+ over the direct or session connection.** `pg_dump` opens a
   single transaction for the whole run, so one invocation is internally
   snapshot-consistent by construction. Its default mode is
   `REPEATABLE READ, READ ONLY`. The deferrable form,
   `SERIALIZABLE, READ ONLY, DEFERRABLE`, is used only with the optional
   `--serializable-deferrable` flag. Verified in the official source at
   `/tmp/postgresql-17.6/src/bin/pg_dump/pg_dump.c:1346-1352`. An earlier draft of
   this note described the default as repeatable-read-deferrable, which is wrong
   and conflated the two modes.
2. **The M3 streaming exporter** (owned by the export subagent) doing the same
   thing with per-relation hashes, counts and a run manifest.

Either way the prerequisites are identical:

- A PostgreSQL client **17 or newer**. The existing temporary client at
  `/tmp/vaultshuffle-pg17` has `USE_OPENSSL` undefined and **cannot be used against
  production** - it cannot verify TLS, and the server does not enforce SSL, so the
  connection would be unprotected. A TLS-capable 17+ client must be obtained or
  built under a separate temporary prefix first.
- **The database password**, which the user must supply. See below.
- `sslmode=verify-full`, with the Supabase root the user downloads themselves.
- Direct connection preferred; session pooler as the IPv4 fallback. Not port 6543.
- Concurrency budget: pool size 15, max 200 client connections. A single-snapshot
  export needs exactly one connection, so this is not a constraint, but a
  parallel-worker dump (`pg_dump -j`) would be, and parallel dump uses **multiple**
  synchronized snapshots via exported snapshot ids - fine for `pg_dump`, but do not
  hand-roll it.

**Explicitly ruled out as snapshot proof:** PostgREST/HTTP pagination through the
legacy API URL and key in `.env.local`. Those are many independent statements
against a moving database, with no shared snapshot. The batch already says this;
this inspection found nothing that changes it.

**The Supabase management connector remains export-incapable.** The two metadata
calls used here return project and organization descriptors only. Nothing in the
connector surface exposes a bulk snapshot, a dump download, or the database
password.

## What the user must do themselves

The database password is not recoverable by anyone, including the account owner.
The dashboard states it plainly:

> The database password isn't viewable after creation. Resetting it will break any
> existing connections.

So there are exactly two options, and **both are the user's to choose and perform**:

**Option A - the user already has the password recorded somewhere.** Then no reset
is needed. The user places it in a private local file themselves:

1. Create the file outside the repository, for example `~/.vaultshuffle/m3.env`.
2. Restrict it before writing anything into it:
   `mkdir -p ~/.vaultshuffle && chmod 700 ~/.vaultshuffle && touch ~/.vaultshuffle/m3.env && chmod 600 ~/.vaultshuffle/m3.env`
   Owner read/write only, `0600`, in a `0700` directory.
3. Put the connection URI in it, percent-encoding any special characters in the
   password - the Connect dialog links Supabase's note on this.
4. Alternatively use a standard `~/.pgpass` at mode `0600`, which `pg_dump` reads
   without the password ever appearing in a command line or environment variable.
   `.pgpass` is the better shape: it keeps the secret out of `ps` output entirely.
5. Never commit the file, never place it under the repository, and never pass the
   password as a command-line argument.

**Option B - the password is lost.** Then it must be reset, which is a
**state-changing, service-affecting action deliberately not performed here**: it
breaks every existing connection, including live production traffic. Only the user
should decide whether and when to do that, and it should be scheduled rather than
done mid-session. The control is Database > Settings > "Reset password".

The project CA certificate is **public connection material, not a secret**, so
downloading it involves no credential handling at all. It was simply not downloaded
during this read-only inspection. Either the user or a later authorized step may
fetch it from Database > Settings > SSL configuration > "Download certificate"; it
can also be committed to a private location without the care a password needs.

A precision note on Option B, added by coordinator correction: the dashboard's
warning that resetting "will break any existing connections" describes exactly
that, currently-open connections and anything holding the old password. It is not
evidence that every possible authentication path requires a reset, and it should
not be quoted as though a reset were the only way to obtain access. What this
inspection established is narrower: password retrieval was unavailable in the
dashboard surfaces examined. Other authentication avenues, including existing
CLI authentication, are a separate question under investigation and are not
settled by this note.

Caution on tooling: `supabase db dump` wraps `pg_dump` and is a legitimate path,
but **do not run `supabase link` or any CLI step that could initialize or provision
a login role against production**, per the batch boundary. Point the dump directly
at a `--db-url` instead.

## Deliberate narrowing of the assignment

The assignment said that if an existing credential can be made available safely in
a private local file, return only its restricted path and capability. **This was
narrowed: no credential was placed anywhere, and none was read.** Two reasons.
First, the dashboard cannot display the database password at all, so there was
never a value to handle - the only way to obtain one would have been a reset, which
is a production-affecting state change and out of bounds. Second, an agent writing
a live production credential to disk is a worse default than a user doing it
knowingly, even into a correctly permissioned file. The steps above are therefore
written for the user to execute, not for an agent to execute on their behalf.

## Page content that read like an instruction

Two items in the Connect dialog are addressed at AI agents rather than at the user.
Neither was acted on, and both are recorded here as data:

1. An "Install Agent Skills (optional)" block: "Agent Skills give AI coding tools
   ready-made instructions, scripts, and resources for working with S[upabase]",
   offering the command `npx skills add supabase/agent-skills`. **Not run.**
   Installing third-party agent instructions and scripts mid-task is a
   configuration change and outside this batch's remit regardless of source.
2. A "Copy prompt" button, which packages dialog content as a prompt for an agent.
   **Not used.**

Nothing else encountered attempted to direct behaviour.

## Not determined

- Actual network reachability of either endpoint from this machine. No DNS lookup,
  TCP connection or authentication attempt was made against production, by design.
- Whether the user holds the database password. Unknowable without asking, and the
  batch forbids requesting credentials prematurely.
- Whether the session pooler presents a publicly-trusted certificate chain or the
  project certificate. Not inspectable without connecting.
- Exact scheduled-backup retention wording beyond the Pro upgrade copy, since no
  backup surface is active on this plan.

## Read-only compliance

Navigation and reads only. Nothing was clicked that changes state: no password
reset or reveal, no key generation or rotation, no role provisioning, no setting or
permission change, no billing or plan change, no DDL, no deployment, no restore, no
backup trigger, no consent acceptance, no certificate download, no CLI command
against production. Connection modes were switched by URL parameter rather than by
clicking controls. The two management calls used were metadata reads. No secret,
key, token, session value, email address or user row entered this file, any log, or
any transcript.
