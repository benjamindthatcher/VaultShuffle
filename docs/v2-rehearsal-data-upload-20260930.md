# Reviewed isolated rehearsal data upload

Destination: VaultShuffle2, `vbjtbwelnhbbdfrqczyf`. Original production remains `pfvblcopcmairdfeqdep` and is not written.

Validated source snapshot: 29 September, 46 relations / 502 columns / 1,091,337 source rows. All source domains reconcile into 60 target relations / 2,110,044 target rows with zero unresolved conflicts or exception records. IGDB is explicitly discarded; permanent Blacklist has no expiry history. UTC instants are preserved.

Protected candidate 8: `/private/tmp/vaultshuffle-m3-export-20260929/local-rehearsal-8`. Data-only dump SHA256 `2bd7081e39b95017a1b4c08e4a9b7d66ab6bf651525b233bb914813e8b42e935` (399,397,447 bytes). Guarded SQL packet SHA256 `ce095baacb297b39bd9fb26e1776b72ea44325e642cd1d10e5469b777e64fba6`. Raw account/session/game data and credentials stay outside Git in owner-only files.

The exact guarded packet has passed a disposable local replay of the target's actual eleven-entry ledger, full restored counts and SQL fingerprints. A repeated import is refused against populated relations. It checks the VaultShuffle2 project marker, exact immutable ledger statement hashes, schema fingerprint, empty data relations and database capacity before COPY; constraints remain active. Count/publication/capacity checks precede commit. A failure rolls back table writes. Since sequence setval is not transactional, the operator wrapper captures 26 dump-owned sequence heads and restores them after failure under the same identity/history/schema/empty-data guards; uncertain outcomes require inspection before retry. The support retention-policy seed remains intact.

Measured local database is 463,342,739 bytes including system tables. Loaded relation/index storage is 451,264,512 bytes. Target baseline is about 19.5 MB; projected target size is about 470.8 MB. This leaves modest headroom against the documented 500 MB Free database quota; exact remote measurement remains an acceptance check. No paid upgrade is included.

The browser cannot stream this 389 MB COPY transaction. Use the browser-confirmed target session pooler `aws-0-us-east-1.pooler.supabase.com:5432` with certificate/hostname verification. Supabase's documented temporary CLI login-role API supplies an expiring administrative credential for this target only; no production password is reset, no public/browser access or persistent application login is created. Refresh the equivalent expiring target credential if needed for read verification, then remove its local password file. It is an operator transport, never an ordinary app credential.

After commit, compare all 63 data/ledger relation counts and exact server-side row-multiset SHA256 fingerprints with the validated local restore, then inspect the result in the browser. Keep activation disabled: snapshot import/cooldown holds and incomplete current-app route integration still block production cutover.

Status: reviewed and locally validated; **remote data upload approval pending**. Approval must identify the account/session/game data, this destination and temporary target administrative transport. Approval for prior source export or six schema followups is not assumed to cover this upload.
