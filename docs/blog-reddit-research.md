# Reddit research for the VaultShuffle blog

Research date: 30 September 2026.

## What was actually checked

The original research was a small qualitative sample without an exact tally. This expanded pass has a deduplicated ledger:

| Measure | Count |
| --- | ---: |
| Targeted Reddit discovery queries | 92 |
| Thread appearances in those results | 466 |
| Distinct Reddit threads screened | 403 |
| Duplicate appearances removed | 63 |
| Relevant threads retained | 234 |
| Unrelated, deleted, promotional or insufficiently clear threads excluded | 169 |
| Retained threads reviewed from indexed post or comment extracts | 185 |
| Retained threads with a separately opened page and sampled opening comments | 15 |
| Retained threads with only title and search snippet evidence | 34 |

**Two hundred retained threads had readable thread text, either indexed extracts or sampled page content.** This does not mean every comment in two hundred full threads was read. Sixteen representative pages were read directly, including one promotional thread subsequently excluded. Direct access failed for some other pages; accessible indexed material is labelled as such.

The ledger records URLs, Reddit post IDs, query batches, exact source titles, review depth, a short evidence excerpt, primary topic and exclusion reason. Post IDs deduplicate language subdomains, title slug variations and repeated hits. No invented dates, votes, search volumes or comment counts were used for ranking.

* [Readable backlog of 23 article briefs](research/reddit-2026-09-30/blog-backlog.md)
* [Thread ledger as CSV](research/reddit-2026-09-30/threads.csv)
* [Thread ledger as JSON](research/reddit-2026-09-30/threads.json)
* [Discovery and competition query log](research/reddit-2026-09-30/queries.json)
* [Backlog as structured JSON](research/reddit-2026-09-30/blog-backlog.json)
* [Representative page review notes](research/reddit-2026-09-30/page-reviews.md)

## Recurring themes in this sample

Each retained thread has exactly one primary theme. These counts describe the targeted sample, **not the most asked questions across Reddit**. Search wording and the engine's selection affect the totals, and different topics received different amounts of searching. Opinion posts supply context; they are not all literal requests for advice.

| Theme | Retained threads |
| --- | ---: |
| Limited time and interruptions | 32 |
| Backlog pressure, finishing and active games | 32 |
| Tracking, duration and unplayed games | 21 |
| Buying, wishlists and bundles | 21 |
| Library organisation, hidden and installed games | 20 |
| Linear games and avoiding required grinding | 15 |
| Mouse play, controllers and comfort | 13 |
| Playing with less experienced friends | 12 |
| Relaxing games and low energy | 12 |
| Steam Families and sharing | 12 |
| Playing without internet | 12 |
| Returning after a break | 11 |
| Games for modest hardware | 11 |
| Discovering overlooked games | 10 |

Upvotes were not used as keyword demand or proof that advice is correct. Indexed dates sometimes disagree with relative dates on fetched pages. An indexed date is preserved where available but is not verified chronology. This pass supports recurring intent, not a precise claim that an issue is increasing in 2026.

## Recommended next article

**How to get back into a game after a long break.** Eleven threads were classified directly under returning after a break. The recurring friction is remembering controls and the story without repeating hours of progress. [Restart or continue?](https://www.reddit.com/r/patientgamers/comments/z2knzn/do_you_guys_restart_games_that_you_played_halfway/) and [a request to relearn unlocked skills](https://www.reddit.com/r/patientgamers/comments/14zmb4i/i_would_love_a_parent_mode_option_in_a_game_that/) make that concrete.

The useful answer is to try the existing save, check controls and the current objective, practise somewhere forgiving, then use a recap limited to progress already made. A separate tutorial save can help where available. This differs from the published choosing article and gives us a natural closing connection to keeping a returning game in Playing Next.

Other strong directions are games that tolerate interruptions, buying fewer games that go unplayed, playing with a less experienced friend, genuine mouse play and focused linear stories. They answer distinct audience problems rather than rewording short Steam Deck games.

## Findings that should shape the articles

* **Short session is not short story.** [This request](https://www.reddit.com/r/gamingsuggestions/comments/1vt6hs6/looking_for_engaging_singleplayer_games_that_are/) explicitly asks for true pause and quick saves, rather than long mission commitments. Test interruption behaviour.
* **Cooperative is not automatically beginner friendly.** In [this request](https://www.reddit.com/r/gamingsuggestions/comments/yikg2r/), Overcooked 2 did not work for a friend just learning a controller. Explain what each player actually has to do.
* **Mouse play is not shorthand for idle games.** [This request](https://www.reddit.com/r/gamingsuggestions/comments/1w0casn/please_recommend_me_steam_games_i_can_play_with/) explicitly wants involved games and rejects idle clickers. Test the whole control flow.
* **Hidden gems need to be genuinely less familiar.** [This indexed request](https://www.reddit.com/r/gamingsuggestions/comments/1g16rbp/) complains about familiar recommendations and asks for little known games. It was not directly retrievable. A data list needs a defensible definition and enough owners to interpret engagement.
* **Dynamic collection behaviour needs current verification.** [One discussion](https://www.reddit.com/r/Steam/comments/1fra2e3/is_it_me_or_dynamic_collections_are_pretty_bad/) raises tag combinations and demos; [another](https://www.reddit.com/r/Steam/comments/1778r87/i_wish_dynamic_collections_had_andorexclude/) distinguishes AND, OR and exclusions. Their old technical answers are not proof of today's client behaviour.
* **Some questions are promotional.** [This collections post](https://www.reddit.com/r/Steam/comments/1r12tvs/how_do_you_organize_your_steam_library/) has replies from its original poster acknowledging game promotion. It is excluded from retained counts, as is a creator's friends in common tool post.
* **Sharing advice changes across product versions.** Older library locking replies conflict with newer copy based discussion. Use current Valve guidance rather than copying Reddit workarounds.

## Search intent and competition

Eight supplemental searches checked prospective article queries outside the discovery corpus. They show some indexed competition, not logged in Google positions, measured keyword difficulty or traffic estimates. New Reddit results from those searches were not added to the 403 thread denominator.

| Intent | Content that appeared | Useful editorial difference |
| --- | --- | --- |
| Returning to a game | Reddit, forums and video material; a card game guide also appeared | A precise guide to an existing video game save, with controls, plot and build examples |
| Games you can pause | Community requests and loosely related results | Test pause, saving and exiting instead of assuming every solo game can pause |
| Buying but not playing | Community discussions including GOG and video advice | A practical purchase pause and correctly qualified library data |
| Playing together | Broad lists from [PCGamesN](https://www.pcgamesn.com/best-co-op-games) and [Digital Trends](https://www.digitaltrends.com/gaming/best-coop-games-pc/) | Focus on one less experienced player, required copies, inputs and modes |
| Mouse games | [SteamDB's tag page](https://steamdb.info/tag/11123/) and a [Steam curator](https://store.steampowered.com/curator/43089204-Good-Mouse-Only-Games/) | Verify real keyboard exceptions and buttons rather than relying on tags alone |
| Linear stories | Forums, opinion pieces and videos | Concrete picks for pacing and direction, without dismissing all open worlds |
| Owned games by length | Tool requests, software projects and [PC Gamer's Steam feature discussion](https://www.pcgamer.com/software/platforms/9-big-things-steam-needs-to-improve-in-2026/) | A current owned library workflow with HLTB estimates correctly credited |
| Library organisation | [Valve's library overview](https://store.steampowered.com/libraryupdate?l=english) and community examples | Research evidence retained; this article has been removed from the editorial queue |

These narrower angles are editorial decisions, not evidence that a keyword is easy to rank for. Broad lists compete with established publications; technical walkthroughs may be answered by Valve. Earn the click with a useful specific answer, without manufacturing freshness or stuffing keyword variants.

## Draft status and further use

Editorial update, 30 September 2026: the user rejected the library organisation article. Its local draft, registry entry, schedule entry and dedicated social image have been removed. The original `steam-family-sharing-play-at-the-same-time` draft was subsequently deleted at the user's request. The user selected **Your Steam family might already own your next favourite game**. It was published in commit `9aba1b7` at `steam-family-library-next-game`, leading with discovery and recommendations before explaining copy availability and VaultShuffle household library features. Other ideas remain unpublished. The original research ledger and its counts are unchanged.

The backlog contains twenty ideas to consider writing, one published family discovery article and two weaker leads requiring further research. Related variations are marked to combine so that several pages do not compete for one intent. Game lists require current documentation and practical testing; original data stories require a fresh, validated sample.
