# Duration triage 2026-09-16: edition-stripped search titles

The 109 in-scope "established game, no HLTB times" rows (215 of the original 324 were DLC or
confirmed non-games already `excluded` in quarantine, so they were left alone). Their catalogue
names carry edition suffixes, which is why the HLTB search returned `hltb_search_not_found`.

These titles were fed to `enrich-hltb.py --input` as `search_title`, which makes them a *trusted*
identity for the gates without writing anything to `game_duration_aliases` first. Persist the ones
that resolved as approved aliases if this needs to be reproducible from the database alone.

The repo's own `edition_retry_variants` only strips a fixed suffix list, so it produced 3 of these.
A broader rule (at most two letter-only words before "Edition", never consuming digits or Roman
numerals) produced the rest. Two were then corrected by hand, because a greedy strip would have
pointed at a different real game:

| AppID | Catalogue name | Search title | Note |
|---|---|---|---|
| 921590 | DISSIDIA FINAL FANTASY NT Free Edition | DISSIDIA FINAL FANTASY NT | hand-corrected (regex ate "NT") |
| 410850 | DRAGON QUEST HEROES™ Slime Edition | DRAGON QUEST HEROES | hand-corrected (regex ate "HEROES"; "Dragon Quest" is a different game) |
| 640820 | Pathfinder: Kingmaker — Enhanced Plus Edition | Pathfinder: Kingmaker | |
| 517630 | Just Cause 4 Reloaded | Just Cause 4 | |
| 231200 | Kentucky Route Zero: PC Edition | Kentucky Route Zero | |
| 32460 | Monkey Island™ 2 Special Edition: LeChuck's Revenge™ | Monkey Island 2: LeChuck's Revenge | mid-title edition; the "2" must survive |
| 214950 | Total War: ROME II - Emperor Edition | Total War: ROME II | |
| 504130 | Manual Samuel - Last Tuesday Edition | Manual Samuel | |
| 597760 | Yuppie Psycho: Executive Edition | Yuppie Psycho | |
| 218410 | Defender's Quest: Valley of the Forgotten (DX Edition) | Defender's Quest: Valley of the Forgotten | |
| 1135260 | The Falconeer: Revolution Remaster | The Falconeer: Revolution | |
| 2229880 | Command & Conquer™ Tiberian Sun™ and Firestorm™ | Command Conquer Tiberian Sun and Firestorm | |
| 649600 | Swords and Sandals 2 Redux | Swords and Sandals 2 | |
| 429180 | Project CARS - Pagani Edition | Project CARS | |
| 635940 | Little Busters! English Edition | Little Busters! | |

The other 95 were searched under their catalogue name unchanged, so a failure for them means HLTB
has no page under any name derivable from the catalogue — not a title-cleanup problem.
