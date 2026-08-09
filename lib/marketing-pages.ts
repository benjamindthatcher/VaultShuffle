import type { Metadata } from "next";
import { siteConfig } from "@/lib/site";

export type MarketingSection = {
  title: string;
  body: string;
  bullets?: string[];
};

export type MarketingPageContent = {
  slug: string;
  navLabel: string;
  metaTitle: string;
  socialTitle: string;
  description: string;
  eyebrow: string;
  title: string;
  intro: string;
  icon: string;
  highlights: Array<{ value: string; label: string }>;
  sections: MarketingSection[];
  steps: Array<{ title: string; body: string }>;
  faqs: Array<{ question: string; answer: string }>;
  ctaTitle: string;
  ctaCopy: string;
};

export const marketingPages: MarketingPageContent[] = [
  {
    slug: "steam-game-picker",
    navLabel: "Game Picker",
    metaTitle: "Steam Game Picker for Your Backlog",
    socialTitle: "Stop scrolling. Pick the right Steam game tonight.",
    description:
      "Use VaultShuffle's free Steam game picker to find what to play from your backlog based on your available time, mood, goal, genres, and collections.",
    eyebrow: "Steam game picker",
    title: "Pick the right Steam game for tonight",
    intro:
      "VaultShuffle turns a crowded Steam library into a focused shortlist. Choose the kind of session you want, tell the Vault how you feel, and draw a game that fits instead of scrolling past hundreds of options.",
    icon: "shuffle",
    highlights: [
      { value: "3", label: "quick choices shape each draw" },
      { value: "Free", label: "to try in guest mode" },
      { value: "Private", label: "Steam handles your password" }
    ],
    sections: [
      {
        title: "A game picker that understands the session",
        body:
          "A purely random Steam picker can land on anything, including a 90-hour RPG when you have half an hour. VaultShuffle starts with the context that changes what a good choice means: session length, mood, and goal.",
        bullets: [
          "Choose a short, evening, or weekend session",
          "Match the pick to a brain-off, chill, or intense mood",
          "Look for something new, finish something, or be surprised"
        ]
      },
      {
        title: "Refine without rebuilding your library",
        body:
          "Optional genre filters and collections narrow the eligible pool when you already know the direction you want. Leave them clear when you want the Vault to surface something you forgot you owned.",
        bullets: [
          "Filter by up to three genres",
          "Draw from your entire library or a chosen collection",
          "Keep sleeping or completed games out of the active pool"
        ]
      },
      {
        title: "See why a game made the cut",
        body:
          "Vault Lens explains how the current deck was assembled, while draw history lets you revisit previous picks. The recommendation is a decision aid you can understand—not a mysterious score you have to trust blindly."
      }
    ],
    steps: [
      { title: "Choose your session", body: "Set the time, mood, and outcome you want from tonight's play." },
      { title: "Shape the pool", body: "Optionally choose genres or one of your custom and smart collections." },
      { title: "Draw from the Vault", body: "Get a focused pick, review why it fits, and start playing." }
    ],
    faqs: [
      {
        question: "Is VaultShuffle just a random Steam game picker?",
        answer:
          "No. Randomness helps break indecision, but VaultShuffle first builds an eligible pool from your session, mood, goal, genres, collection, and game status."
      },
      {
        question: "Can I try it without connecting Steam?",
        answer:
          "Yes. Guest mode uses a realistic demo library so you can test the complete picking flow before signing in."
      },
      {
        question: "Does VaultShuffle see my Steam password?",
        answer:
          "No. Authentication happens on Steam. VaultShuffle receives your Steam identity and the library data Steam makes available, never your password."
      }
    ],
    ctaTitle: "Your next game is already in your library",
    ctaCopy: "Try the complete Vault flow now, or connect Steam to pick from the games you actually own."
  },
  {
    slug: "steam-backlog-manager",
    navLabel: "Backlog",
    metaTitle: "Steam Backlog Manager That Helps You Choose",
    socialTitle: "Turn your Steam backlog into games you will actually play.",
    description:
      "Organise your Steam backlog by progress, priority, playtime, and collections—then let VaultShuffle help you choose, finish, or safely set games aside.",
    eyebrow: "Steam backlog manager",
    title: "Turn your Steam backlog into a playable plan",
    intro:
      "A backlog should create possibilities, not guilt. VaultShuffle helps you understand what you own, decide what deserves attention, and reduce the distance between browsing your library and actually starting a game.",
    icon: "backlog",
    highlights: [
      { value: "One view", label: "for status, playtime, and priority" },
      { value: "Flexible", label: "collections for every kind of player" },
      { value: "No guilt", label: "sleep games without deleting them" }
    ],
    sections: [
      {
        title: "Know the state of every game",
        body:
          "Track games as not started, in progress, completed, or sleeping. Add priorities and notes so the library reflects your intentions instead of becoming an undifferentiated wall of cover art.",
        bullets: [
          "See playtime and progress together",
          "Pin the games you genuinely want to return to",
          "Separate active choices from games you are done considering"
        ]
      },
      {
        title: "Build useful slices of the backlog",
        body:
          "Custom collections work for personal themes such as co-op night or games for Steam Deck. Smart Collections automatically surface useful groups such as short games, untouched titles, story-rich picks, or games already in progress."
      },
      {
        title: "Triage neglected games safely",
        body:
          "Purge is a review workflow, not a delete button. It helps you mark games completed, keep them active, pin them, or put them to sleep while preserving the choice to change your mind later."
      }
    ],
    steps: [
      { title: "Sync", body: "Bring in the owned-game data Steam makes available for your profile." },
      { title: "Organise", body: "Set status, priority, notes, and collections around how you really play." },
      { title: "Act", body: "Draw a game, continue something active, or review the titles you keep avoiding." }
    ],
    faqs: [
      {
        question: "Will VaultShuffle delete games from my Steam account?",
        answer:
          "No. VaultShuffle organises its own view of your library. Sleeping or reviewing a game does not remove the licence from Steam."
      },
      {
        question: "Do I need to organise everything before using the picker?",
        answer:
          "No. You can draw from the synced library immediately and add statuses, priorities, or collections gradually."
      },
      {
        question: "What happens to games I put to sleep?",
        answer:
          "They move out of the active decision pool but remain recorded, so you can restore them later."
      }
    ],
    ctaTitle: "Make the backlog useful again",
    ctaCopy: "Start with the guest library or connect Steam and organise the collection you already own."
  },
  {
    slug: "steam-library-manager",
    navLabel: "Library",
    metaTitle: "Steam Library Manager for Games and Progress",
    socialTitle: "See your whole Steam library clearly.",
    description:
      "Search, filter, organise, and track your Steam game library with statuses, playtime, progress, priorities, notes, collections, and focused game picks.",
    eyebrow: "Steam library manager",
    title: "See your whole Steam library clearly",
    intro:
      "VaultShuffle gives your owned games a practical layer Steam does not: one focused view for finding, sorting, annotating, and deciding what to play next without losing the connection to Steam.",
    icon: "library",
    highlights: [
      { value: "Fast", label: "search and multi-filter views" },
      { value: "Personal", label: "status, priority, notes, and progress" },
      { value: "Connected", label: "playtime and metadata from Steam" }
    ],
    sections: [
      {
        title: "Find games without endless scrolling",
        body:
          "Search by title, switch between grid and list views, and combine filters for status, genre, priority, playtime, or collection. The result is a library that answers questions instead of creating more of them.",
        bullets: [
          "Surface untouched or in-progress games",
          "Filter around the time and genre you want",
          "Sort the collection around playtime or personal priority"
        ]
      },
      {
        title: "Add the context Steam cannot know",
        body:
          "Set a completion percentage, write private notes, choose a priority, or mark the game sleeping. Those decisions stay attached to the title and shape the choices available in the Vault."
      },
      {
        title: "Move from library management to play",
        body:
          "The library is connected to VaultShuffle's game picker and collections. A useful filter can become a collection; a collection can become tonight's eligible pool; and a pick can move straight into your active progress."
      }
    ],
    steps: [
      { title: "Connect Steam", body: "Sign in on Steam and sync the owned-game data available for your account." },
      { title: "Create your view", body: "Search, filter, sort, and add the personal context that matters to you." },
      { title: "Choose what is next", body: "Open a game, add it to a collection, or send the focused pool to the Vault." }
    ],
    faqs: [
      {
        question: "Does VaultShuffle replace the Steam client?",
        answer:
          "No. It is a companion for organising and choosing. Steam still handles ownership, installation, launching, and authentication."
      },
      {
        question: "Why might a Steam game be missing?",
        answer:
          "Steam must make owned-game data available for the profile. A private games list can prevent titles from appearing until the visibility setting changes and the library is refreshed."
      },
      {
        question: "Can I add my own notes and priorities?",
        answer:
          "Yes. VaultShuffle stores personal organisation such as notes, status, progress, and priority alongside synced game information."
      }
    ],
    ctaTitle: "A cleaner view of every game you own",
    ctaCopy: "Explore the full library workflow with demo data, or connect Steam to organise your own collection."
  },
  {
    slug: "steam-wishlist-tracker",
    navLabel: "Wishlist",
    metaTitle: "Steam Wishlist Tracker for Prices and Priorities",
    socialTitle: "Turn a long Steam wishlist into a useful shortlist.",
    description:
      "Track your Steam wishlist with current prices, discounts, priority, and collection context so you can spot the games worth buying and playing next.",
    eyebrow: "Steam wishlist tracker",
    title: "Turn your Steam wishlist into a useful shortlist",
    intro:
      "A wishlist can become another backlog before you buy anything. VaultShuffle brings price context and personal priority together so you can focus on the games that are both a good deal and a good fit.",
    icon: "wishlist",
    highlights: [
      { value: "Current", label: "Steam price and discount context" },
      { value: "Focused", label: "priority instead of wishlist order" },
      { value: "Connected", label: "wishlist and owned library together" }
    ],
    sections: [
      {
        title: "See price and preference together",
        body:
          "Review the current price and discount information Steam makes available, then add your own priority. A large percentage discount is useful context, but it does not automatically make a game the right purchase.",
        bullets: [
          "Spot currently discounted wishlist games",
          "Mark the titles you genuinely care about",
          "Distinguish a tempting sale from a strong next purchase"
        ]
      },
      {
        title: "Avoid buying what you already have",
        body:
          "Wishlist and owned-library context sit in the same product, making it easier to notice when the best next game is already waiting in your backlog."
      },
      {
        title: "Keep the decision in your hands",
        body:
          "VaultShuffle does not purchase games or change your Steam wishlist. It gives you a clearer decision surface and links you back to Steam when you are ready to act."
      }
    ],
    steps: [
      { title: "Sync the wishlist", body: "Import the wishlist data and pricing information Steam currently exposes." },
      { title: "Add your priority", body: "Separate must-watch games from titles that merely looked interesting once." },
      { title: "Make a better choice", body: "Compare the sale with your current backlog before opening the title on Steam." }
    ],
    faqs: [
      {
        question: "Does VaultShuffle send price-drop notifications?",
        answer:
          "Not currently. The wishlist view shows the latest price and discount context available when the data is refreshed."
      },
      {
        question: "Can VaultShuffle buy or remove wishlist games?",
        answer:
          "No. Purchases and Steam wishlist changes remain on Steam; VaultShuffle is an independent organisation and decision tool."
      },
      {
        question: "Are prices guaranteed to be live?",
        answer:
          "Prices depend on the latest data returned by Steam and can vary by region or change between refreshes. Confirm the final price on Steam before purchasing."
      }
    ],
    ctaTitle: "Buy fewer games you will never start",
    ctaCopy: "See how wishlist priorities, sale context, and your existing library work together in VaultShuffle."
  },
  {
    slug: "how-it-works",
    navLabel: "How It Works",
    metaTitle: "How VaultShuffle Picks Your Next Steam Game",
    socialTitle: "How VaultShuffle turns your Steam library into one good choice.",
    description:
      "Learn how VaultShuffle securely connects to Steam, organises your library, builds an eligible game pool, and helps you choose what to play next.",
    eyebrow: "How VaultShuffle works",
    title: "From a crowded Steam library to one good choice",
    intro:
      "VaultShuffle combines the library facts Steam provides with the context only you know—your available time, current mood, goal, and personal organisation—to make the next decision smaller and more useful.",
    icon: "open-vault",
    highlights: [
      { value: "Steam", label: "handles secure authentication" },
      { value: "You", label: "set the context and stay in control" },
      { value: "Vault", label: "builds and explains the eligible pool" }
    ],
    sections: [
      {
        title: "Steam authentication, without sharing your password",
        body:
          "The sign-in takes place with Steam. VaultShuffle receives the Steam identity needed to recognise your account and sync the information Steam makes available; your Steam password is never sent to or stored by VaultShuffle."
      },
      {
        title: "Your library becomes a decision system",
        body:
          "Owned games, playtime, genres, status, progress, priorities, and collections create useful ways to understand the library. You can start with the sync immediately and organise more over time."
      },
      {
        title: "The Vault builds an eligible deck",
        body:
          "Session, mood, goal, optional genres, and the selected collection determine which games are eligible. Vault Lens shows the construction of that deck, and draw history keeps previous recommendations easy to revisit."
      }
    ],
    steps: [
      { title: "Connect or try the demo", body: "Use Steam for your real library or guest mode for a complete, no-commitment preview." },
      { title: "Add your context", body: "Organise gradually, then choose the session, mood, goal, genres, and collection for this draw." },
      { title: "Draw, understand, play", body: "Review the pick and its eligible pool, then open Steam when you are ready to play." }
    ],
    faqs: [
      {
        question: "Is VaultShuffle affiliated with Valve or Steam?",
        answer:
          "No. VaultShuffle is an independent service. Steam and the Steam logo are trademarks of Valve Corporation."
      },
      {
        question: "What data does VaultShuffle use?",
        answer:
          "It uses the Steam identity and library or wishlist fields described on the Steam Data page, plus the organisation and progress information you add inside VaultShuffle."
      },
      {
        question: "Can I delete my VaultShuffle data?",
        answer:
          "Yes. The Steam Data and Privacy pages explain what is stored and how to request correction or deletion."
      }
    ],
    ctaTitle: "See the complete flow before connecting Steam",
    ctaCopy: "Guest mode lets you test the picker, library, collections, wishlist, and backlog tools with realistic demo data."
  }
];

export const marketingNavigation = marketingPages.map(({ slug, navLabel }) => ({
  href: `/${slug}`,
  label: navLabel
}));

export function getMarketingMetadata(page: MarketingPageContent): Metadata {
  const path = `/${page.slug}`;

  return {
    title: page.metaTitle,
    description: page.description,
    alternates: { canonical: path },
    openGraph: {
      title: page.socialTitle,
      description: page.description,
      url: path,
      type: "website",
      images: [{
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "VaultShuffle — pick the right Steam game for tonight"
      }]
    },
    twitter: {
      card: "summary_large_image",
      title: page.socialTitle,
      description: page.description,
      images: [siteConfig.ogImage]
    }
  };
}
