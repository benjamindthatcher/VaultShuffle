import { BarRow, DataTable, PostCta } from "@/components/blog/BlogPieces";
import type { PostContent } from "@/lib/blog/posts";
import { blogStats, formatCount, statsAsOf } from "@/lib/blog/stats";

export function shortGamesFinished(): PostContent {
  const bands = blogStats.completionByLength;
  const { library } = blogStats;
  const maxPct = Math.max(...bands.map((band) => band.pctFinished));
  const totalStarted = bands.reduce((sum, band) => sum + band.started, 0);

  return {
    overview: (
      <>
        <p>
          The advice you get about a backlog is always the same: play something short. It fits
          neatly with how people talk about their piles. The eighty hour RPG is the thing that
          defeats them, so a four hour game should be the thing that doesn&apos;t.
        </p>
        <p>
          VaultShuffle holds both halves of the data needed to check that. It knows how long
          games take, from HowLongToBeat, for {formatCount(blogStats.catalogue.withDurations)}{" "}
          games. And it knows which games people marked finished:{" "}
          {formatCount(library.completions)} of them, as of {statsAsOf}.
        </p>
      </>
    ),
    sections: [
      {
        title: "Not really",
        icon: "completed",
        body: (
          <>
            <p>
              Of the people who started a game, meaning it has more than zero playtime, here
              is the share who went on to mark it finished, grouped by how long the main story
              takes.
            </p>
            <div>
              {bands.map((band) => (
                <BarRow
                  key={band.band}
                  label={band.band}
                  value={band.pctFinished}
                  max={maxPct}
                  display={`${band.pctFinished}%`}
                />
              ))}
            </div>
            <p>
              It is flat. A game you can beat in ninety minutes gets finished{" "}
              {bands[0].pctFinished}% of the time. A game that takes over forty hours gets
              finished {bands[bands.length - 1].pctFinished}% of the time. The best band does{" "}
              {bands[1].pctFinished}%, and the difference between best and worst is under three
              percentage points across {formatCount(totalStarted)} started games.
            </p>
            <DataTable
              columns={["Main story", "Started", "Finished", "Share finished"]}
              rows={bands.map((band) => [
                band.band,
                formatCount(band.started),
                formatCount(band.completed),
                `${band.pctFinished}%`
              ])}
              caption={`VaultShuffle libraries as of ${statsAsOf}. Finite games only, because an endless game has no finish to reach.`}
            />
          </>
        )
      },
      {
        title: "So why does the advice feel true?",
        icon: "details",
        body: (
          <>
            <p>
              Because the games people name as their finishing successes really are short ones.
              Sort the same data by completion rate and the top is INSIDE, Firewatch, The Room,
              Brothers, Gone Home and Unpacking: narrative shorts, all under nine hours.
            </p>
            <p>
              But that is a different claim. Those games are not finished because they are
              short. They are finished because they are the kind of game built to be finished:
              one arc, no systems to grind, nothing that turns into a second job. Length is a
              symptom of that design, not the cause of the outcome.
            </p>
            <p>
              Meanwhile the twenty to forty hour band is full of games people are genuinely
              playing and will genuinely return to. They sit unfinished for months without being
              abandoned, and a snapshot cannot tell those apart from the ones given up on.
            </p>
          </>
        )
      },
      {
        title: "The limit of this number",
        icon: "id",
        body: (
          <>
            <p>
              &quot;Finished&quot; here means a VaultShuffle user marked the game completed.
              That is a deliberate action in the app, so this is a marking rate, not a true
              completion rate, because it undercounts anyone who finished a game and never came back to
              tick it off. The absolute percentages are therefore low, and it is the shape across
              bands, not the height, that carries the finding.
            </p>
            <p>
              Endless games are excluded throughout using VaultShuffle&apos;s own
              classification, which is the only reason this comparison works at all: without it,
              the long bands fill up with games that have no ending to reach.
            </p>
          </>
        )
      },
      {
        title: "What to do with this instead",
        icon: "goal",
        body: (
          <>
            <p>
              Pick short games because you want a complete thing in one or two evenings, which
              is a real and good reason. Do not pick them believing length is what has been
              stopping you.
            </p>
            <p>
              What the data does support is narrower and more useful: the games that get finished
              are the ones that fit the session you actually have in front of you. That is a
              question about tonight, not about the size of your library.
            </p>
            <PostCta
              heading="Match the game to the evening"
              body="Tell VaultShuffle how long you have and what you want from the session. It ranks what you own against that, and picks one."
            />
          </>
        )
      }
    ]
  };
}
