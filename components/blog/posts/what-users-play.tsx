import { DataTable, PostCta } from "@/components/blog/BlogPieces";
import type { PostContent } from "@/lib/blog/posts";
import { blogStats, formatCount, statsAsOf } from "@/lib/blog/stats";

export function whatUsersPlay(): PostContent {
  const { mostPlayed, mostFinished, library } = blogStats;

  return {
    overview: (
      <>
        <p>
          Every &quot;most popular games&quot; chart is really an ownership chart, and ownership
          on Steam is a bad measure of anything. Libraries fill up with bundle filler, free
          weekend claims, Prime Gaming giveaways, and beta clients that install as their own
          entry. Rank by how many people own something and you mostly learn what Valve put in a
          package.
        </p>
        <p>
          We tried it the other way. Across {formatCount(library.libraries)} libraries and{" "}
          {formatCount(library.ownedRows)} owned games, this ranks by what people actually did
          with a game: what share of owners ever launched it, how many hours the typical player
          put in, and how often it got finished.
        </p>
      </>
    ),
    sections: [
      {
        title: "What people actually sink time into",
        icon: "trophy",
        body: (
          <>
            <DataTable
              columns={["Game", "Owners", "Launched", "Average hours", "Finished"]}
              rows={mostPlayed.map((game) => [
                game.name,
                formatCount(game.owners),
                `${game.pctLaunched}%`,
                `${game.medianHours}h`,
                `${game.pctFinished}%`
              ])}
              caption={`VaultShuffle libraries as of ${statsAsOf}. Finite games with at least 40 owners and 25 players. "Average hours" counts only people who launched it.`}
            />
            <p>
              The top is not surprising, and that is the point. ELDEN RING, Baldur&apos;s Gate
              3 and Cyberpunk 2077 are games people bought deliberately and then really played.
              What is interesting is the column that usually gets left out. Baldur&apos;s Gate 3
              has an average of {mostPlayed[1].medianHours} hours per player, which is a genuine
              commitment, and {mostPlayed[1].pctFinished}% of the people who started it have
              marked it finished.
            </p>
          </>
        )
      },
      {
        title: "Time played and getting finished are different things",
        icon: "completed",
        body: (
          <>
            <p>
              Sort the same libraries by completion rate instead and almost nothing from the list
              above survives.
            </p>
            <DataTable
              columns={["Game", "Main story", "Players", "Finished"]}
              rows={mostFinished.slice(0, 8).map((game) => [
                game.name,
                `${game.mainHours}h`,
                formatCount(game.started),
                `${game.pctFinished}%`
              ])}
              caption="Share of players who marked the game finished, among those who launched it."
            />
            <p>
              These are two different kinds of game and two different kinds of evening. One list
              is what you disappear into for a season; the other is what you finish. A library
              needs both, and the mistake is looking at a shelf full of the first kind on a
              Tuesday night with an hour to spare.
            </p>
          </>
        )
      },
      {
        title: "How the ranking works",
        icon: "id",
        body: (
          <>
            <p>
              Score is launch rate multiplied by average hours among players, weighted up by
              completion rate, with average hours capped so that one genre of very long game
              cannot take the whole table. Games need at least 40 owners and 25 actual players to
              appear, and endless games are excluded, because otherwise the list is MMOs and idle games,
              which win any contest about hours played by definition rather than by merit.
            </p>
            <p>
              &quot;Finished&quot; means a user marked it completed in VaultShuffle, so it
              undercounts anyone who finished a game and never ticked it off. These are{" "}
              {formatCount(library.libraries)} libraries belonging to people who went looking
              for a backlog tool, which is not a random sample of Steam.
            </p>
          </>
        )
      },
      {
        title: "Find out what your own library says",
        icon: "in-library",
        body: (
          <PostCta
            heading="Your library, ranked the same way"
            body="VaultShuffle reads your playtime and progress, then picks something that fits tonight rather than something that needs a season."
          />
        )
      }
    ]
  };
}
