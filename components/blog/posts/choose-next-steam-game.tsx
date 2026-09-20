import Link from "next/link";
import { PostCta } from "@/components/blog/BlogPieces";
import type { PostContent } from "@/lib/blog/posts";

export function chooseNextSteamGame(): PostContent {
  return {
    overview: (
      <>
        <p>
          You open Steam with an evening to yourself and somehow spend the first half hour
          looking at games instead of playing one. There is the RPG you meant to start,
          the strategy game you would have to learn again, and something from a sale that
          you have completely forgotten buying. Eventually you launch the usual favourite,
          or close the whole thing and watch something instead.
        </p>
        <p>
          When you cannot decide what to play, it helps to make the question smaller. Think
          about the time and energy you have tonight, narrow your Steam library to three
          games that fit, then give one a proper session. You can do that yourself or let
          VaultShuffle help with the choice, without planning the fate of every game you own.
        </p>
      </>
    ),
    sections: [
      {
        title: "Choose for tonight, not your entire backlog",
        pane: true,
        icon: null,
        body: (
          <>
            <p>
              The game you are most excited to have finished is not always the one you want
              to play after work. A sprawling RPG can be exactly your thing and still feel
              like too much when you are tired, particularly if the first task is remembering
              who everyone is and why your inventory is full of spoons.
            </p>
            <p>
              Before looking at individual games, decide what would feel good right now.
              Do you want a challenge, a story to get lost in, or something familiar enough
              that you can settle straight into it? Then think about how much time you
              actually have, including any download or update standing between you and
              the opening screen.
            </p>
            <p>
              Total game length only tells part of the story. A long game you already know
              might suit half an hour better than a short game with an elaborate opening.
              Look for a useful stopping point, whether that is a mission, a puzzle or the
              next save, rather than assuming a short campaign means short sessions.
            </p>
          </>
        )
      },
      {
        title: "Give yourself three games to choose from",
        pane: true,
        icon: null,
        body: (
          <>
            <p>
              Pick three games you already own that suit the evening you have in mind,
              perhaps something you were enjoying last week, something untouched and an old
              favourite. Keep those choices together in a Steam collection if it helps, then
              make your decision there instead of going back to the full library.
            </p>
            <p>
              Keep it practical. If you want something relaxing, leave the demanding games
              for another night. If you fancy a fresh start, look at the games you have
              barely touched. If a particular genre is calling to you, let that be enough
              to rule out the others for now.
            </p>
            <p>
              If two choices still seem equally appealing, pick whichever is installed and
              ready. It is a perfectly reasonable tie breaker when the alternative is spending
              the rest of your evening comparing review scores for games you already own.
            </p>
          </>
        )
      },
      {
        title: "Let a Steam game picker make the final call",
        pane: true,
        icon: null,
        body: (
          <>
            <p>
              When several games sound equally good, letting something else choose can be
              a relief. A random Steam game picker can break the tie, but a result from your
              entire library might send you straight back to scrolling if it ignores what
              you actually feel like playing.
            </p>
            <p>
              That is the problem we built VaultShuffle around. Connect your public Steam
              library, choose your session, mood and goal, and the Vault draws from the
              strongest eligible matches. It also explains the pick, so you have something
              more useful to go on than a title appearing on screen.
            </p>
            <p>
              For an evening when you want to unwind with something unfamiliar, try Chill
              and Something New, with a genre filter if you have one in mind. If you would
              rather return to a game already underway, choose Finish Something. Completed
              games stay out of the draw, and you can remove games you do not want to play
              from future picks without removing them from your Steam library.
            </p>
            <p>
              The result is a suggestion, not a promise that the game will suit you perfectly.
              Read the reasons and see whether you actually want to press play. If you do,
              that is a good enough reason to stop comparing it with everything else.
            </p>
          </>
        )
      },
      {
        title: "How to choose from your own Steam library",
        pane: "getting-started",
        icon: null,
        body: (
          <>
            <p>
              VaultShuffle is free. To get suggestions from the games you own, you need
              to bring in your Steam library first:
            </p>
            <ol>
              <li>
                <strong>Bring your library.</strong> Continue with Steam from the{" "}
                <Link href="/" data-blog-action="open_home">VaultShuffle homepage</Link>,
                or <Link href="/setup/steam-profile" data-blog-action="import_library">enter your public Steam profile</Link>.
                Your profile and game details need to be public so the games can be imported.
              </li>
              <li>
                <strong>Set up a draw.</strong> Choose a session, mood and goal in the Vault,
                then add a genre filter if there is something specific you fancy.
              </li>
              <li>
                <strong>Read your pick.</strong> Check the reasons it was suggested and open
                it in Steam when you are ready. You can pin it to keep it handy, remove it
                from future picks or draw again.
              </li>
            </ol>
            <p>
              If you would rather look around first, guest mode lets you draw from a sample
              library without connecting Steam. When you do sign in through Steam, it happens
              on Steam itself and VaultShuffle never receives your Steam password.
              The <Link href="/faq" data-blog-action="faq">FAQ</Link> covers imports,
              privacy and what happens to your saved choices.
            </p>
          </>
        )
      },
      {
        title: "Give the game a chance before choosing again",
        pane: "getting-started",
        icon: null,
        body: (
          <>
            <p>
              Once you have a pick, play far enough to get past the settings menu and see
              what it is offering. That might be the first mission or a few rounds rather
              than a fixed number of minutes. You will have a much better idea of whether
              you fancy another session once you have actually had a go.
            </p>
            <p>
              If it does not land, use that to make the next choice easier. Perhaps you
              wanted less reading, more action or something you already knew how to play.
              If you know you do not want to play it, remove it from your picks in
              VaultShuffle so the same unwanted suggestion does not keep appearing.
            </p>
            <p>
              If reaching the credits is what would get you excited about starting, our picks for{" "}
              <Link
                href="/blog/steam-deck-games-you-can-beat-in-under-10-hours"
                data-blog-action="open_post"
                data-post-slug="steam-deck-games-you-can-beat-in-under-10-hours"
              >short Steam Deck games you can beat in under 10 hours</Link>{" "}
              are a useful place to look. Otherwise, leave the rest of the backlog for another
              day and see where this game takes you.
            </p>
          </>
        )
      },
      {
        title: "",
        body: (
          <PostCta
            heading="Still staring at your Steam library?"
            body="Try a draw with the sample library, then bring your own games when you are ready. VaultShuffle is free."
          />
        )
      }
    ]
  };
}
