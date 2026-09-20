import { PostCta, StatGrid } from "@/components/blog/BlogPieces";
import type { PostContent } from "@/lib/blog/posts";
import { blogStats, formatCount, statsAsOf } from "@/lib/blog/stats";

export function unplayedLibrary(): PostContent {
  const { library } = blogStats;

  return {
    overview: (
      <>
        <p>
          Everyone who owns a lot of games on Steam has a rough sense that most of them are
          untouched. Nobody has a number, because the number is hard to get: Steam will tell
          you your own playtime, and it will not tell you anyone else&apos;s in aggregate.
        </p>
        <p>
          VaultShuffle imports libraries to work out what to recommend, which means it holds
          playtime for every game in every library connected to it. As of {statsAsOf} that is{" "}
          {formatCount(library.libraries)} libraries and {formatCount(library.ownedRows)} owned
          games.
        </p>
      </>
    ),
    sections: [
      {
        title: "Two thirds is the number that matters",
        icon: "playtime",
        body: (
          <>
            <StatGrid
              stats={[
                {
                  value: `${library.pctNeverLaunched}%`,
                  label: "have never been launched",
                  note: `${formatCount(library.neverLaunched)} games with zero recorded playtime`
                },
                {
                  value: `${library.pctUnderOneHour}%`,
                  label: "have under an hour played",
                  note: "Launched once, or never"
                },
                {
                  value: formatCount(library.ownedRows),
                  label: "owned games measured",
                  note: `Across ${formatCount(library.libraries)} libraries`
                }
              ]}
            />
            <p>
              The headline figure people usually quote is the one for games never launched at all, and at{" "}
              {library.pctNeverLaunched}% it is close to the figures that circulate from other
              studies. It is also the less interesting of the two.
            </p>
            <p>
              <strong>
                {library.pctUnderOneHour}% of owned games have under an hour on them.
              </strong>{" "}
              That gap, between never opening a game and opening it once, is where a backlog
              actually lives. A game with forty minutes played is not an unopened purchase.
              Somebody installed it, started it, got through the opening, and never went back.
              There are more of those than there are games nobody has ever opened.
            </p>
          </>
        )
      },
      {
        title: "Why the second number is the honest one",
        icon: "details",
        body: (
          <>
            <p>
              A game nobody ever launched can be explained away. Steam libraries fill up with things
              nobody chose: bundle filler, free weekend claims, Prime Gaming giveaways, beta
              clients and test servers that install as separate entries. A large share of the
              pile with no playtime at all is stuff that was never a decision in the first place.
            </p>
            <p>
              An hour of playtime cannot be explained away like that. Somebody meant to play it.
              The number for under an hour is measuring intent that went nowhere, and that is a
              different and more uncomfortable thing than a library inflated by free stuff.
            </p>
          </>
        )
      },
      {
        title: "How this was measured",
        icon: "id",
        body: (
          <>
            <p>
              Every figure above counts rows in VaultShuffle&apos;s own database as of{" "}
              {statsAsOf}: one row per game per connected library, restricted to games the
              account actually owns. Games shared through Steam Families are excluded, because Steam does not
              expose playtime for a borrowed copy.
            </p>
            <p>
              Playtime is whatever Steam reported at the last library refresh, so anything
              played offline and not yet synced reads low. These are{" "}
              {formatCount(library.libraries)} libraries belonging to people who sought out a
              backlog tool, which is not a random sample of Steam. If anything it is biased
              toward people whose backlog already bothers them.
            </p>
          </>
        )
      },
      {
        title: "What this does not mean",
        icon: "heart",
        body: (
          <>
            <p>
              It does not mean everyone wasted their money. Plenty of that pile was
              bought at ninety percent off in a sale, and a game bought for two pounds and
              played for forty minutes has broken about even against a coffee.
            </p>
            <p>
              What it does mean is that the constraint on playing more of your library was never
              acquisition. It is the ten minutes you spend scrolling before giving up. The pile
              is not a shopping problem; it is a deciding problem.
            </p>
            <PostCta
              heading="Your next game is already in there"
              body="Pick a session length, a mood and a goal. VaultShuffle scores what you own against them and picks one, with the reasons attached."
            />
          </>
        )
      }
    ]
  };
}
