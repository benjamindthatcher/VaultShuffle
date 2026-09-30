import Link from "next/link";
import { PostCta } from "@/components/blog/BlogPieces";
import type { PostContent } from "@/lib/blog/posts";

const STEAM_FAMILIES = "https://help.steampowered.com/en/faqs/view/054C-3167-DD7F-49D4";

export function steamFamilyDiscovery(): PostContent {
  return {
    overview: (
      <>
        <p>
          There is a particular kind of Steam evening where you spend more time looking
          for a game than playing one, usually with your wishlist open and a sale doing
          its best to convince you that the answer costs another fifteen pounds. Before
          you give in, it might be worth asking what everyone else in the house has been
          playing, because the game you need could already be sitting in their library.
        </p>
        <p>
          Steam family sharing lets eligible games from your household appear in your
          own library through Steam Families, which makes that recommendation your
          partner or sibling keeps bringing up rather easier to act on. Beyond the
          familiar games you have both bought, there might be a detective story you
          missed, a strategy game you never quite committed to or something so far
          outside your usual tastes that you would never have gone looking for it.
        </p>
      </>
    ),
    sections: [
      {
        title: "Start with the game they keep telling you to play",
        pane: "discovery",
        icon: null,
        body: (
          <>
            <p>
              Anyone who plays games has at least one they cannot resist recommending,
              and asking someone in your family about theirs is a much better opening
              than staring at another page of review scores. Find out what made it stick:
              perhaps the puzzles kept surprising them, the story took a turn they are
              trying very hard not to spoil, or a supposedly quick session somehow
              swallowed the rest of their evening. That gives you something to look
              forward to when you press play.
            </p>
            <p>
              This gets more interesting when your tastes barely overlap, because someone
              who buys different games has already done some exploring you have not.
              If you usually head straight for action games, a slower mystery might be
              an unexpectedly good fit for a quiet night; if strategy games always looked
              intimidating, having someone who knows the opening hours can make starting
              one feel much less daunting. A shared copy gives you room to find out
              whether you like it before worrying about whether you should buy it.
            </p>
          </>
        )
      },
      {
        title: "How to find your Steam family's games",
        pane: "discovery",
        icon: null,
        body: (
          <>
            <p>
              Shared games appear alongside your own in the Steam library, so enable{" "}
              <strong>Group By Library</strong> in the dropdown above the game list if
              you want to browse them separately. Valve&apos;s{" "}
              <a href={STEAM_FAMILIES}>Steam Families guide</a> shows where to find the
              setting, and it is a useful way to see the games you can borrow without
              scrolling past all the ones you bought yourself.
            </p>
            <p>
              Look for the recommendation you had in mind, but leave room for something
              you recognise from an old wishlist or a trailer you liked and then forgot.
              Those are often the most appealing discoveries: games that had already
              caught your attention, then slipped away while you were busy playing
              something else. Ask whoever owns it what the opening is like and whether
              it suits the time you have tonight, rather than assuming the biggest or
              most expensive game must be the best place to start.
            </p>
            <p>
              Once something sounds good, give it enough time to show you why it belongs
              in their favourites. You might find yourself planning another session
              before the first is over, or decide that their enthusiasm has not quite
              rubbed off on you, which is fine too. Having access to their collection
              is a chance to try more things, and it does not come with an obligation
              to finish every game in it.
            </p>
          </>
        )
      },
      {
        title: "Can you both play at the same time?",
        pane: "family-library",
        icon: null,
        body: (
          <>
            <p>
              With Steam Families, you can play different shared games at the same time,
              even when both belong to one person. Playing the same game in separate
              sessions needs an available shareable copy for each player, so if there
              is only one and someone is using it, you will need to wait or pick
              something else. Sharing does not add a multiplayer mode to a game either,
              so check that separately if you want to play together.
            </p>
            <p>
              Steam Families is intended for up to six close family members in one
              household, with setup under Account Details and Family Management.
              Eligibility checks and cooldowns can affect joining, while publisher,
              account and regional restrictions, private games and parental controls
              can limit access to individual titles. Check Steam and Valve&apos;s{" "}
              <a href={STEAM_FAMILIES}>sharing guidance</a> if a game is missing or unavailable.
            </p>
          </>
        )
      },
      {
        title: "Find something worth playing from your family library",
        pane: "family-library",
        icon: null,
        body: (
          <>
            <p>
              Of course, adding someone else&apos;s games can leave you with even more
              to choose between, particularly when everyone has a different suggestion.
              That is where VaultShuffle&apos;s <strong>Family library</strong> can help:
              add the public Steam profiles of the people in your household and titles
              identified as shareable join your Library and your draws. Their profiles
              and game details need to be public for the import to work.
            </p>
            <p>
              Choose <strong>Family only</strong> under the Library filter when you
              want to look beyond your own purchases, then set your session, mood and
              goal in the Vault to narrow the choice. You might fancy something unfamiliar
              for a quiet evening or a longer game to get stuck into, and when a suggestion
              catches your attention, saving it to <strong>Playing Next</strong> keeps
              it handy for another session.
            </p>
            <p>
              Steam still decides what you can actually launch, because VaultShuffle
              estimates sharing eligibility from public data rather than checking family
              membership or whether a copy is busy. Adding a profile here does not set
              up a Steam Family, and borrowed games do not bring the owner&apos;s playtime
              into your stats. Our <Link href="/faq" data-blog-action="faq">FAQ</Link>{" "}
              covers imports, while the guide to{" "}
              <Link href="/blog/how-to-choose-your-next-steam-game" data-blog-action="open_post" data-post-slug="how-to-choose-your-next-steam-game">
                choosing your next Steam game
              </Link>{" "}
              can help if you are still torn between a few possibilities.
            </p>
            <p>
              Before you head back to the store, give the games your family already has
              a look. The one they have been telling you about for months might finally
              make sense once you have played it, and you will have something better
              to talk about than whether either of you needs another game in the sale.
            </p>
          </>
        )
      },
      {
        title: "",
        body: (
          <PostCta
            heading="Find something worth borrowing"
            body="Try a draw with the sample library, then bring your own games and your family's shelves into VaultShuffle."
          />
        )
      }
    ]
  };
}
