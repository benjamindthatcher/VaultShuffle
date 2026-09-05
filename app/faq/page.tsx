import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import { pageOpenGraph, pageTwitter } from "@/lib/site";

const description =
  "Answers about VaultShuffle's free Steam game picker and backlog manager: Steam sign-in, library imports, recommendations, filters, devices, missing games, privacy, and deletion.";

export const metadata: Metadata = {
  title: "Steam Backlog Manager FAQ",
  description,
  alternates: { canonical: "/faq" },
  openGraph: pageOpenGraph({ url: "/faq", title: "VaultShuffle FAQ", description }),
  twitter: pageTwitter({ title: "VaultShuffle FAQ", description })
};

const FAQ_ITEMS = [
  {
    question: "What is VaultShuffle?",
    answer:
      "VaultShuffle is a free Steam backlog manager and game picker. It imports your public library, helps you organise games and suggests what to play next based on your available time, mood and goal."
  },
  {
    question: "How does VaultShuffle pick a game?",
    answer:
      "For a guided draw, VaultShuffle applies your filters and game statuses, then ranks eligible games using your session, mood, goal and game data. It makes a weighted choice from the strongest matches and shows the reasons behind the result."
  },
  {
    question: "Is it just a random Steam game picker?",
    answer:
      "A guided draw uses randomness to choose between strong matches, rather than treating every game equally. Session and mood affect ranking; they do not guarantee a perfect fit. The option to skip the questions draws from a wider pool of eligible games."
  },
  {
    question: "How do I import my Steam library?",
    answer:
      "Sign in with Steam, or enter a public Steam profile URL, custom profile name or SteamID. Your profile and game details need to be public for the import to work. You can also try guest mode with a sample library."
  },
  {
    question: "Is signing in with Steam safe?",
    answer:
      "Steam handles sign-in on its own website through OpenID. VaultShuffle receives confirmation of your SteamID, then reads public profile and library data through Steam's API. It never receives your Steam password or changes your Steam account."
  },
  {
    question: "Do I have to sign in with Steam?",
    answer:
      "No. A public-profile import creates a separate VaultShuffle profile without verifying ownership of the Steam account. Your library and choices are saved on the server, with access tied to this browser's session. You can verify and link the profile through Steam later."
  },
  {
    question: "What do Session, Mood and Goal mean?",
    answer:
      "Session is the time you have, Mood is the level of effort you want, and Goal is whether you want to start something, make progress or be surprised. These choices shape a guided draw. You can skip them for a broader pick; collection draws use the selected collection instead."
  },
  {
    question: "What is ruled out before a draw?",
    answer:
      "Games marked completed or asleep, and games with an active snooze, are excluded from draws. Your global filters also apply, and some goals exclude further games—for example, Finish Something excludes endless games. Pinned games stay accessible on the Dashboard even if you change your filters."
  },
  {
    question: "Does VaultShuffle work for Steam Deck, Mac and Linux?",
    answer:
      "Yes. Mac and Linux filters use native platform support, so the Linux filter does not include Windows-only games that might work through Proton. The Steam Deck filter includes games marked Playable or Verified. Missing or outdated compatibility data can affect results; check Steam for your setup."
  },
  {
    question: "Does VaultShuffle support Steam Families?",
    answer:
      "Yes. Add a family member's public Steam profile to include games estimated to be shareable from their library. Shared games are labelled, but Steam decides whether you can actually play them. VaultShuffle cannot read your playtime for those copies. You can disable family libraries, and a game you later buy becomes owned after a library refresh."
  },
  {
    question: "What can I do after VaultShuffle picks a game?",
    answer:
      "You can open it in Steam, pin it, snooze it or draw again. Up to three pins appear on the Dashboard. Owned games show playtime and progress estimates where available; shared games show their source instead. Automatic and manual refreshes keep owned-game playtime up to date when Steam is available."
  },
  {
    question: "Does VaultShuffle learn what I like?",
    answer:
      "Actions such as playing, pinning, completing, snoozing and rerolling games influence future picks. This changes the odds within the eligible matches; it does not remove games from the shortlist or restrict you to one genre."
  },
  {
    question: "Why is a game missing from my library?",
    answer:
      "First check your Library filters and game statuses. If the game was not imported, Steam privacy settings, an incomplete API response or missing catalogue data may be the cause. Demos, tools and other non-game apps may be excluded. Shared games need an added family profile with a public library."
  },
  {
    question: "Is VaultShuffle free?",
    answer:
      "Yes. VaultShuffle has no paid tier, subscription or payment-card requirement."
  },
  {
    question: "Can I delete my VaultShuffle data?",
    answer:
      "Yes. Contact support to request deletion of your VaultShuffle profile and associated data. Signing out only ends access from this browser; it does not delete the saved profile. Deletion does not affect your Steam account or games."
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
        intro="Help with library imports, game recommendations, filters and your VaultShuffle account."
        icon="details"
        overview={{
          title: "About VaultShuffle",
          body: (
            <>
              <p>
                VaultShuffle helps you choose what to play from your Steam library. You can try a sample library,
                import a public profile or sign in through Steam. The questions below explain how it works.
              </p>
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
