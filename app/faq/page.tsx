import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import { pageOpenGraph, pageTwitter } from "@/lib/site";

const description =
  "Answers about VaultShuffle's free Steam backlog manager, including library imports, game picks, Playing Next, collections, Wishlist, completion tracking and account access.";

export const metadata: Metadata = {
  title: "Steam Backlog Manager FAQ",
  description,
  alternates: { canonical: "/faq" },
  openGraph: pageOpenGraph({ url: "/faq", title: "VaultShuffle FAQ", description }),
  twitter: pageTwitter({ title: "VaultShuffle FAQ", description })
};

const FAQ_ITEMS = [
  {
    question: "What is VaultShuffle, and is it free?",
    answer:
      "VaultShuffle is a free Steam backlog manager and game picker. It helps you choose what to play from your library, organise your games and keep track of what you finish. There is no paid tier or subscription."
  },
  {
    question: "How do I import my Steam library?",
    answer:
      "Sign in with Steam, or enter your public Steam profile URL, custom profile name or SteamID. Your Steam profile and Game details must be public. If your playtime is missing, also check whether Steam is set to keep your total playtime private, then refresh your library."
  },
  {
    question: "Can I use VaultShuffle without signing in through Steam?",
    answer:
      "Yes. Try guest mode with a sample catalogue, or use a public Steam profile URL to create a VaultShuffle profile for that library. The URL option does not verify ownership: anyone with the same public profile link can access that VaultShuffle profile. Use Steam login if you want access tied to ownership of your Steam account."
  },
  {
    question: "Can I return to my profile on another device?",
    answer:
      "Yes. Sign in with the same Steam account, or enter the same public profile URL if that is how you started. These methods use separate VaultShuffle profiles, so switching between them does not transfer your saved choices. Guest wishlist saves stay in that browser and do not transfer when you sign in."
  },
  {
    question: "Is it safe to sign in with Steam?",
    answer:
      "You sign in on Steam's own website. VaultShuffle receives confirmation of your SteamID and reads public profile and library data. It never receives your Steam password or permission to change your Steam account, games or purchases."
  },
  {
    question: "How does VaultShuffle pick a game?",
    answer:
      "A guided draw uses Session for the time you have, Mood for the kind of experience you want, and Goal for starting something new, finding a nearby finish or being surprised. It favours stronger matches within your filters and explains the result. Roll the dice skips those choices and picks randomly from eligible games."
  },
  {
    question: "Why are there no games available for my draw?",
    answer:
      "Completed and blacklisted games stay out of draws. Global filters, selected genres, your goal and any active snoozes can narrow the pool further. Finish Something also needs a started game with a credible estimate of time remaining. Check Vault Lens to see what is narrowing your pool, then loosen a filter or try Surprise Me."
  },
  {
    question: "Can I filter games for Steam Deck, Mac or Linux?",
    answer:
      "Yes. Use the global device filter on the Dashboard. Steam Deck includes games marked Playable or Verified. Mac and Linux use native platform support, so Linux does not include every Windows game that might run through Proton. Compatibility data can change, so check Steam before playing."
  },
  {
    question: "Can I include games from my Steam Family?",
    answer:
      "Yes. Add a family member's public profile through Family Library on the Dashboard. VaultShuffle includes games it identifies as shareable and labels their source. Steam still decides whether you can play them, and VaultShuffle cannot read your personal playtime for those shared copies."
  },
  {
    question: "What can I do after a game is picked?",
    answer:
      "Launch it with Play now, or use View on Steam when launching is unavailable. Save for later adds it to Playing Next, which holds up to three games on the Dashboard and in the Vault. You can replace a saved game when full, Reroll for another pick or Blacklist a game you do not want suggested."
  },
  {
    question: "Can I bring back a game I blacklisted or marked complete?",
    answer:
      "Yes. Find it using the Library's status filters, open its details and choose Reactivate. Blacklist and Complete only change how VaultShuffle treats the game. Neither removes it from your Steam library."
  },
  {
    question: "Does VaultShuffle learn what I like?",
    answer:
      "Your play history and actions such as saving, launching, completing, blacklisting and rerolling games can influence recommendations. Learned preferences help choose between suitable games without overriding your filters. They are not applied to every guided draw, and Roll the dice and collection draws stay random."
  },
  {
    question: "What are collections for?",
    answer:
      "Collections group your library into shelves. Choose the games yourself or create a smart collection that updates automatically from its preset. In the Vault, Collection Draw picks randomly from eligible games on the selected shelf. These collections are separate from your Steam collections."
  },
  {
    question: "Does VaultShuffle know when I have finished a game?",
    answer:
      "You decide when a game is complete. The completion check suggests games to review based on playtime, or you can mark one Complete in the Library. Progress and time remaining compare Steam playtime with estimated playthrough lengths. They cannot see your save file, so replaying, side content and idle time can affect the estimate."
  },
  {
    question: "How does Wishlist work with my Steam wishlist?",
    answer:
      "Wishlist helps you discover and save games to consider buying. You can search Steam, browse recommendations or import your public Steam wishlist into your VaultShuffle profile. Importing adds games without removing existing saves. Changes here do not update Steam's wishlist. Displayed prices use your selected region; check Steam for the final price."
  },
  {
    question: "Why is a game or recent playtime missing?",
    answer:
      "Check your Library and global filters, then choose Refresh from Steam in your profile menu. Your profile and Game details must be public, and a large import may still be processing. Steam can also return incomplete data or leave out private games, demos and other apps. If refreshing does not help, contact support."
  },
  {
    question: "Does the Dashboard show what I spent on games?",
    answer:
      "No. Library value uses available Steam store prices, not your purchase history. Value recovered is the share of that value represented by games you marked complete, and value per hour compares price with playtime. Family games are excluded from these figures."
  },
  {
    question: "Can I delete my VaultShuffle data?",
    answer:
      "Yes. Use the Contact page to request deletion of your VaultShuffle profile and associated data. Signing out only ends the current browser session. Deleting VaultShuffle data does not affect your Steam account or games."
  }
] as const;

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer
    }
  }))
};

export default function FAQPage() {
  return (
    <SharedInformationShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c") }}
      />
      <InfoPage
        eyebrow="Help · Steam backlog manager"
        title="VaultShuffle FAQ"
        intro="Help with your Steam library, game picks, saved games and VaultShuffle profile."
        icon="details"
        overview={{
          title: "Need a hand?",
          body: (
            <>
              <p>
                See <Link href="/releases">what&apos;s new</Link>, read about <Link href="/steam-data">what Steam data is used</Link>,
                or <Link href="/contact">contact us</Link> if your question is not covered below.
              </p>
            </>
          )
        }}
        sections={FAQ_ITEMS.map((item, index) => ({
          title: item.question,
          body: <p>{item.answer}</p>,
          open: index < 2
        }))}
      />
    </SharedInformationShell>
  );
}
