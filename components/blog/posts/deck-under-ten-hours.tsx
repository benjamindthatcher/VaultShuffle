import { PostCta, PostOutro } from "@/components/blog/BlogPieces";
import { GamePicks, type Pick } from "@/components/blog/GamePicks";
import { fetchPicks } from "@/lib/blog/game-lists";
import type { PostContent } from "@/lib/blog/posts";

/** The filter the post claims. The picks are checked against it on every build. */
const FILTER = {
  deck: "verified",
  durationKind: "finite",
  mainStoryHours: [1, 10],
  minReviews: 500,
  minPositive: 0.85
} as const;

/**
 * Ten, ordered shortest first.
 *
 * The order is the data, so it needs no defending, and the spread is the point:
 * an hour and a half at one end, most of a weekend at the other, one co-op game,
 * and tones from cosy to genuinely punishing. The notes are written copy and the
 * page prints them as they are, so this array is where they get edited.
 */
const PICKS: readonly Pick[] = [
  {
    // 01 A Short Hike
    appid: 1055540,
    note: "The gentlest game on this list and probably the easiest to recommend. You play as a bird exploring a tiny island on the way to its summit, but there is no rush to get there and almost every detour gives you something worth finding. Our players spend a little longer with it than the main story takes, which feels appropriate for a game built around wandering off course."
  },
  {
    // 02 What Remains of Edith Finch
    appid: 501300,
    note: "A house full of stories, each one stranger than the last. What Remains of Edith Finch plays more like a collection of short stories than a traditional game, with each chapter standing neatly on its own. That makes it especially easy to play on the Deck for an hour, put down and come back to without losing the thread."
  },
  {
    // 03 INSIDE
    appid: 304430,
    note: "INSIDE wastes absolutely nothing. No dialogue, no exposition and very little standing between you and the next brilliant set piece. It also has the highest completion rate of any game in our libraries here, which fits a game that is remarkably hard to put down once it gets moving."
  },
  {
    // 04 Unpacking
    appid: 1135690,
    note: "Unpacking really is a game about taking things out of boxes and finding somewhere to put them. Somehow, across eight moves and hundreds of ordinary objects, it manages to tell an entire life story without saying a word. It suits the Deck beautifully when you want something calm, although it works better on the sofa than somewhere you are likely to be interrupted every five minutes."
  },
  {
    // 05 Firewatch
    appid: 383870,
    note: "Firewatch is mostly walking, talking and wondering whether the person on the other end of the radio is telling you everything. That sounds simple, but it is exactly why it works so well on the Deck, especially when you want something absorbing without much friction. Our average playtime sits almost exactly on its main story length too."
  },
  {
    // 06 Katana ZERO
    appid: 460950,
    note: "Katana ZERO is built around failure, but it rarely wastes your time. You die in one hit, restart almost instantly and keep replaying a room until a chaotic few minutes become one perfect sequence. Our players tend to stop well before the estimated story length, so this is one of the tougher recommendations here, but few games on the list feel better once everything clicks."
  },
  {
    // 07 Papers, Please
    appid: 239030,
    note: "Papers, Please somehow turns checking passports into one of the most stressful jobs in games. Every shift adds new rules, new mistakes to make and another reason to process the next person a little faster. Its day by day structure works naturally on the Deck, while our library data suggests plenty of players see enough of Arstotzka to reach an ending and leave it there."
  },
  {
    // 08 Stray
    appid: 1332010,
    note: "Yes, you are a cat, and that is obviously part of the appeal. What makes Stray such a good Deck game is how little friction there is between its quieter exploration, light puzzles and bigger set pieces. Its average playtime is almost identical to the main story estimate, so it also lands very neatly in that one week game territory."
  },
  {
    // 09 Celeste
    appid: 504230,
    note: "Celeste is the hardest game on this list, but it is unusually kind about letting you struggle. Rooms are short, restarts are instant and its assist options mean the difficulty never has to become a wall. Our completion rate is the lowest here by some distance, so expect more resistance than the eight hour estimate might suggest."
  },
  {
    // 10 Portal 2
    appid: 620,
    note: "Portal 2 is the longest game here, but it is still short enough to finish without giving up the rest of your month. Its puzzles keep introducing new ideas without becoming exhausting, and fifteen years later it still teaches its mechanics better than almost anything else on Steam. Our average playtime lands within minutes of the main story estimate, which makes it a fitting place to end a list built around games you can realistically finish."
  }
];

export async function deckUnderTenHours(): Promise<PostContent> {
  const picks = await fetchPicks(PICKS.map((pick) => pick.appid), FILTER);

  return {
    overview: (
      <>
        <p>
          The Steam Deck is at its best when you do not really have time to play games. Twenty
          minutes before bed or half an hour on a train can still be enough to make real
          progress. You can pick it up, play for a while and carry on later without needing to
          set aside an entire evening.
        </p>
        <p>
          Short games suit that kind of play especially well. A brief session can still feel
          worthwhile and it is usually easy to come back after a few days away. Across a week,
          those small pockets of time can be enough to actually reach the credits.
        </p>
        <p>
          So we have picked 10 Steam Deck Verified games you can beat in under 10 hours, ordered
          from shortest to longest. We have also looked at the VaultShuffle data behind each one,
          including how many players finish them and how long they tend to spend playing.
        </p>
      </>
    ),
    sections: [
      {
        /* No heading either: the games are the page. */
        title: "",
        body: (
          <>
            <GamePicks picks={PICKS} data={picks} />
            <PostOutro>
              <p>
                Short games are one of the best fits for the Steam Deck because they make even
                small amounts of free time feel useful. If choosing what to play is still the
                hard part, VaultShuffle can narrow down the games you already own and help you
                find something worth starting.
              </p>
            </PostOutro>
            <PostCta
              heading="Which of these are already sitting in your library?"
              body="VaultShuffle reads your Steam library, keeps what runs on your Deck, and picks something that fits tonight."
            />
          </>
        )
      }
    ]
  };
}
