# The post formula

Written 2026-09-17, from reading how the sites that win these queries actually
build a page. The job is a post someone clicks from a search result and then
keeps reading, which are two different problems: the first is answered by the
title and the first screen, the second by whether the page has anything in it.

## What the research actually showed

**IGN** ([The 12 Shortest Open World Games to Play in 2023](https://www.ign.com/articles/shortest-open-world-games))
is the closest model, because it is a list post about game length that ranks.
Its shape:

1. H1 with **a number and a year** — "The 12 Shortest Open World Games to Play
   in 2023".
2. A dek that sells the *range*, not the topic — "From short and sweet indies to
   action-packed expansions for games you already know and love".
3. Byline, date, comment count.
4. Two paragraphs of intro, and they do different jobs. The first is the
   reader's situation ("if you don't have 50 hours to devote to a new save").
   The second states plainly what the list is, **where the data came from**, and
   its range: "we've collected the top 12 ... according to How Long to Beat ...
   these games range from a little over an hour long to around seven hours".
5. Then entries, each identical in shape:
   - Game name as the heading
   - `Time to beat: 1h 20m, on average, for the Main Story`
   - `Platforms: Available on PC, PlayStation 3, PlayStation Vita`
   - One paragraph: what it is, why it is here, **a quote from IGN's own review**,
     and a closing line that puts the number in human terms — "you can easily
     cross it off your list in an evening".
6. Ordered *by the data*, shortest first, so the ordering needs no defending.

**Our World in Data** ([internet](https://ourworldindata.org/internet)) is the
model for the stats posts rather than the lists: a hook paragraph, then **a
single prominent number above the fold**, charts interleaved with the prose that
explains them, and a citation block at the end. No methodology section — the
sourcing is stated inline where each figure appears.

**BacklogCoach** ([too many steam games](https://backlogcoach.com/blog/too-many-steam-games-guide))
is the direct rival and the thinnest of the three, which is instructive: a
**table of contents** at the top, a ~50-word intro, imperative numbered subheads
("Accept the Truth", "Sort Your Library", "Shrink Your List"), no boxed
summaries, a "The Result" section that restates the benefit, then two CTAs.
It ranks on structure and brevity, not substance.

**DeckAlly** ([short steam deck games](https://deckally.com/blog/short-steam-deck-games))
puts **methodology before the entries** and closes with "How we keep this list
fresh" instead of an FAQ — the freshness claim is the differentiator it leans on,
and it is the one we can actually back.

## The formula

### Every post

| Slot | Rule |
|---|---|
| **Title** | A number where there is one, and the answer in the first 60 characters. "Steam Deck Verified Games You Can Beat in Under 10 Hours" works because the answer precedes the brand. |
| **Dek** | Sells the range or the surprise, not the subject. One sentence. |
| **Byline row** | Topic, date, read time. Dates are non-negotiable on a post making a data claim. |
| **First screen** | The answer, before any context. If a reader bounces here they should still have got the thing they searched for. |
| **Headline number** | One figure, large, above the fold. Stats posts have this already; list posts use the qualifying count. |
| **Subheads** | Phrased as the question a reader would ask, not as a label. "Why Verified matters more than Playable", not "Verification". |
| **Sourcing inline** | State where a number came from next to the number, the way Our World in Data does. No separate methodology dump. |
| **Caveat, in the post** | One honest limit, stated plainly. This is the single biggest difference between our posts and the rival's, and it is what makes a sceptical reader trust the rest. |
| **One CTA** | At the end, phrased at the reader's question, not the product's features. Not two, not a banner mid-article. |

### List posts additionally

- **Ordered by the data**, so the order defends itself.
- **A fixed data line per entry**, same fields in the same order — length, Deck
  verdict, review score. This is what the `GameList` table already does, and
  the table is *better* than IGN's per-entry prose for scanning. Where a post
  wants the IGN treatment, the top few entries get a sentence each and the rest
  stay in the table.
- **The count, stated**: "718 games clear all three". A number a hand-written
  listicle cannot print is the whole advantage.
- **A freshness claim we can honour** — the list is a query, so it is correct
  after the nightly workers move a duration. Say so, the way DeckAlly does,
  because unlike them we are not claiming it by hand.

### Stats posts additionally

- **The number, then the better number.** The unplayed post already does this:
  52.4% is the figure people expect, 64.9% is the one that says something.
- **A chart or bar per claim**, next to the claim.
- **The finding that went against us**, kept. "We checked whether short games
  get finished more often. They don't." A post that reports a result it did not
  want is the most credible thing on the site.

## Where I had the formula wrong

**"Answer first" is for question posts, not list posts.** The table above says
the first screen should answer the query before any context, and for "how long
is X" that is right. Applied to a list post it produced an opening that was a
specification: the three criteria, the qualifying count, a justification of why
the filter is Verified rather than Playable. All true, all unreadable.

None of the researched sites open that way. IGN opens on a feeling, "it's an
incredible feeling when you're fully immersed in an open world game", then one
clause of sourcing, then games. On a list post the games *are* the answer, so two
sentences of something a person would actually say costs nothing and the list
still arrives immediately.

**Sections do not need labels.** "The short version" and "The ten" were the page
introducing itself. A post is a headline, a standfirst, and then the thing. The
article variant of InfoPage now renders no heading when the title is empty, and
a list post should use that.

## The failure mode to watch for

**A methodology section reads as the page explaining itself.** The first draft
of the Deck post had "How these were chosen" and "What these numbers can and
cannot tell you", running to six paragraphs about the query, which filters did
the work, and what the figures could not support. Every sentence was true and
none of it was content: it was engineering self narration wearing a content hat,
and it is instantly recognisable as machine written.

Note that none of the four sites researched has one. IGN attributes its data in
a single clause, "according to How Long to Beat", and moves on to the games.
DeckAlly is the only one with anything close, and theirs is a freshness claim
rather than a defence of its own filters.

The honest caveat the formula asks for is still worth having. It is one line, in
small type, under the thing it qualifies. If it needs a heading, it has stopped
being a caveat and become an apology.

## What not to do

- No "In this article we will explore" paragraph. It is the thing that makes a
  reader leave, and it is what the removed index panel was.
- No mid-article CTA banner. One at the end.
- No FAQ block bolted on for the rich result. If a question is worth answering
  it is worth a subhead; `FAQPage` markup on a question nobody asked is the
  scaled-content smell.
- No number without its date. Every figure we publish moves.

## Not in scope here, but worth knowing

**IGN Playlist** ([playlist.ign.com](https://playlist.ign.com)) is a direct
competitor nobody had on the list: backlog tracking across platforms, ratings,
**HowLongToBeat time estimates**, "discover what to play", and shareable
playlists. It turned up while researching this — IGN's `/playlist/*` pages rank
for the same short-games queries the blog is aimed at, with user-made lists like
"Beat in a Weekend — 50 games you can balance with life".

That is the same product idea with IGN's domain authority behind it. It belongs
in §2 of [seo-growth-plan.md](seo-growth-plan.md) and it changes the read on the
competitive set: the threat is not BacklogShuffle, it is a games-media giant
shipping the feature as a side project. Their lists are hand-made and
user-curated, which is still the gap — ours are queries.
