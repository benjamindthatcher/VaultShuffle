# What counts as a game

A draw is only worth trusting if everything it can land on is something a player
can sit down and play. The quarantine is what keeps DLC, demos, soundtracks,
benchmarks, test builds and desktop utilities out of that pool.

`lib/catalogue-classification.ts` holds the whole decision. It is pure and
covered by `lib/catalogue-classification.test.ts`; nothing else should be
deciding this question.

## Three verdicts

| Verdict | `review_status` | Effect |
| --- | --- | --- |
| excluded | `excluded` | Hidden everywhere. `user_games_with_catalog.is_quarantined` is true. |
| review | `pending` | **Still visible.** A flag for a person, not a decision. |
| accepted | no row | Nothing to answer for. |

`pending` deliberately does not hide anything. Hiding a game somebody owns is
worse than briefly showing an oddity, so an uncertain signal fails open and
waits for a human.

## What Steam's `type` field is worth

Steam's storefront type is trustworthy for `dlc`, `demo`, `music`, `movie` and
`hardware`. It is close to worthless for everything else, and acting on the rest
is what put a shelf of real games behind the quarantine:

- **`advertising` means nothing.** It is a marker left on legacy store pages.
  59 of the 65 AppIDs it had flagged were plainly games — Prey, Rayman 2,
  Darksiders II, World in Conflict, Ghost Recon Advanced Warfighter.
- **`mod` means nearly nothing.** 27 of 29 were standalone free games needing no
  host game: Portal Stories: Mel, Entropy : Zero, NEOTOKYO°, Deus Ex: Revision.
- **`video`, `series` and `episode`** mislabel real games too; Babel Rising is
  typed `video`.
- **`game` does not prove it is a game.** Wallpaper Engine, RetroArch, Fantasy
  Grounds, Dungeon Alchemist and every Movavi product are typed `game`.

Steam's PICS record disagrees with the storefront in both directions and is no
safer on its own: it types Half-Life 2: Episode One and Episode Two as `tool`,
and types the six RACE 07 expansion SKUs as `game` even though none of them
launches without RACE 07.

## The rules that do work

1. **Definitive types.** `dlc`, `demo`, `music`, `movie`, `hardware` → excluded.
2. **The `fullgame` pointer.** Steam sets it on content belonging to a parent
   app. It is what catches the RACE 07 expansions. A self-reference is ignored —
   some legacy pages point at themselves (Full Pipe, 4600).
3. **Software genres.** A genre set drawn *entirely* from Steam's software-only
   genres, with no game genre left over, is software. Across the full 25,988-row
   catalogue this matched 464 apps with no false positives. `free to play`,
   `early access` and `indie` are not game genres and rescue nothing; `casual`
   is one, so casual and educational games stay safe.
4. **Free prologues.** Steam's current fashion is shipping a demo as its own
   free app typed `game`. Being buyable is the difference: KINGDOM HEARTS HD 2.8
   Final Chapter Prologue ($59.99) and START AGAIN: a prologue ($10.99) are whole
   games; the other 72 were tasters.
5. **Channel names.** Each pattern needs an explicit channel word — "open beta",
   "test server", "PTS", "benchmark". A bare "beta" is routinely part of a
   shipped name (Serious Sam Fusion 2017 (beta), CUCKOLD SIMULATOR: Life as a
   Beta Male Cuck), so it only earns a review flag.

Anything with a software genre *alongside* a game genre is flagged, not hidden.

## Where evidence is thin

`recordAutomaticSteamQuarantine` runs on an import payload: a title and a joined
genre string, with no Steam type, price or categories. It only ever stages
`pending`. On that evidence a paid game called "… Prologue" is indistinguishable
from a free demo of the same name, so the ingest worker — which has fetched the
full record — is the only thing that excludes anything.

## Changing the rules

`catalog_games` carries a `steam_type = 'game'` check constraint, so the true
type of a non-game is only ever recorded on the quarantine row. The catalogue
therefore cannot be re-derived from itself; a rule change needs a fresh pass over
Steam. Re-run the audit rather than trusting `catalog_games.steam_type`, which is
`'game'` for all 25,988 rows by construction.

A manual decision (`source = 'manual'`) always wins and is never overwritten by
a worker. Use it for the judgement calls the rules cannot reach.
