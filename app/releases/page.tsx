import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import { pageOpenGraph, pageTwitter } from "@/lib/site";
import styles from "./releases.module.css";

const description =
  "VaultShuffle release notes for the free Steam backlog manager: new features, smarter game picks, Steam library improvements, visible changes, and fixes by version.";

export const metadata: Metadata = {
  title: "Releases",
  description,
  alternates: { canonical: "/releases" },
  openGraph: pageOpenGraph({ url: "/releases", title: "VaultShuffle Release Notes", description }),
  twitter: pageTwitter({ title: "VaultShuffle Release Notes", description })
};

type Tag = "new" | "improved" | "changed" | "fixed";
type Change = { tag: Tag; text: string };
type Group = { icon: VaultIconName; title: string; summary: string; items: Change[] };
type Highlight = { icon: VaultIconName; title: string; text: string };

/* What a reader wants first is what they can now do, then what behaves
   differently, then what got better, then what stopped being broken. Items are
   sorted by this at render time rather than by hand, so a release cannot end up
   in authoring order by accident. */
const TAG_ORDER: Record<Tag, number> = { new: 0, changed: 1, improved: 2, fixed: 3 };

const TAG_CLASS: Record<Tag, string> = {
  new: styles.tagNew,
  improved: styles.tagImproved,
  changed: styles.tagChanged,
  fixed: styles.tagFixed
};

const RELEASE_1_1_HIGHLIGHTS: Highlight[] = [
  {
    "icon": "family",
    "title": "Family libraries",
    "text": "Add family members’ public Steam libraries and include their eligible games in your picks."
  },
  {
    "icon": "filter",
    "title": "Global filters",
    "text": "Choose which games appear across your library, collections and recommendations."
  },
  {
    "icon": "all-games",
    "title": "Library controls",
    "text": "Review completed and set-aside games in the Library. The separate Purge page has been removed."
  }
];

const RELEASE_1_1_GROUPS: Group[] = [
  {
    "icon": "family",
    "title": "Family libraries",
    "summary": "Add the public Steam profiles of people in your Steam family. VaultShuffle uses their libraries and game metadata to estimate which games can be shared; Steam determines whether you can play them.",
    "items": [
      {
        "tag": "new",
        "text": "Eligible games from added family members appear in the Library and Vault draws, with a shared-game marker."
      },
      {
        "tag": "new",
        "text": "Buying a previously shared game updates its existing library entry on your next import."
      },
      {
        "tag": "new",
        "text": "Turn family libraries off, or use the Library filter to show owned games, family games or both."
      },
      {
        "tag": "improved",
        "text": "Removing a family member asks for confirmation and shows how many imported games may be removed. Games also shared by another added member are retained."
      },
      {
        "tag": "fixed",
        "text": "An incomplete family-library read now reports an error instead of presenting a partial import as complete."
      }
    ]
  },
  {
    "icon": "filter",
    "title": "Global filters",
    "summary": "Set preferences for release age, player mode, game type, device, ownership and reviews. Category exclusions let you hide types of game you do not want included.",
    "items": [
      {
        "tag": "new",
        "text": "Global filters apply to the connected library used throughout the app."
      },
      {
        "tag": "new",
        "text": "Exclude categories such as horror or sports from the games shown."
      },
      {
        "tag": "new",
        "text": "Linux mode shows games listed with native Linux support. Steam Deck mode uses Valve’s Playable and Verified ratings."
      },
      {
        "tag": "improved",
        "text": "Pinned games remain accessible from the Dashboard even when they do not match your global filters."
      }
    ]
  },
  {
    "icon": "grid",
    "title": "Navigation and layout",
    "summary": "Library controls now cover the review actions previously found in Purge. The Dashboard and Vault also have simpler layouts for common actions.",
    "items": [
      {
        "tag": "changed",
        "text": "The Purge page has been replaced by Library controls for setting games aside, marking them completed and restoring them."
      },
      {
        "tag": "changed",
        "text": "The app uses a darker page background to separate panels more clearly."
      },
      {
        "tag": "new",
        "text": "Launch a game in Steam from the Dashboard."
      },
      {
        "tag": "improved",
        "text": "Open setup panels close when you draw a game."
      },
      {
        "tag": "improved",
        "text": "The Dashboard shows fewer routine import and maintenance messages."
      },
      {
        "tag": "fixed",
        "text": "Game artwork in the collection picker is no longer cropped incorrectly."
      }
    ]
  },
  {
    "icon": "id",
    "title": "Connecting a library",
    "summary": "Import a public Steam library without signing in. This creates a saved VaultShuffle profile accessed through the current browser’s session.",
    "items": [
      {
        "tag": "new",
        "text": "Enter a public Steam profile URL, custom profile name or SteamID to import its library."
      },
      {
        "tag": "new",
        "text": "Use Steam sign-in later to secure a browser profile. If a verified profile already exists, the linking flow combines supported saved data."
      }
    ]
  },
  {
    "icon": "pin",
    "title": "Pinned games",
    "summary": "Keep up to three games on the Dashboard. Progress displays use the available playtime and duration data, with separate displays for endless and shared games.",
    "items": [
      {
        "tag": "new",
        "text": "Pinned games show playtime since pinning, progress and estimated time remaining where that information is available."
      },
      {
        "tag": "new",
        "text": "A daily refresh updates owned pinned-game playtime from Steam. You can also request a refresh from the Dashboard."
      },
      {
        "tag": "fixed",
        "text": "Shared pins display their owner instead of a playtime or completion estimate. Marking a shared game completed still records your decision."
      }
    ]
  },
  {
    "icon": "shuffle",
    "title": "Recommendations",
    "summary": "The final draw uses a narrower group of close matches. Game classification and completion handling have also been adjusted.",
    "items": [
      {
        "tag": "improved",
        "text": "Guided draws focus on a smaller set of the closest matches, while retaining games tied at the cutoff."
      },
      {
        "tag": "improved",
        "text": "Game tags help distinguish games with an ending from ongoing or endless games."
      },
      {
        "tag": "fixed",
        "text": "Marking many games completed at once has less influence on recommendation preferences, so bulk library updates do not outweigh recent playing choices."
      },
      {
        "tag": "fixed",
        "text": "A high playtime-to-duration ratio no longer incorrectly counts against short games."
      },
      {
        "tag": "fixed",
        "text": "Broad genre labels no longer incorrectly classify some simulation games as endless."
      }
    ]
  },
  {
    "icon": "new",
    "title": "Personalisation",
    "summary": "Actions on individual games now contribute to recommendation preferences alongside genre history. These preferences adjust the final draw without changing which games enter the shortlist.",
    "items": [
      {
        "tag": "new",
        "text": "Launching, pinning, finishing, snoozing and rerolling provide signals for later picks."
      },
      {
        "tag": "improved",
        "text": "Shared preference signals can reduce the selection weight of games that players regularly set aside."
      },
      {
        "tag": "improved",
        "text": "Playtime contributes to the preference estimate when direct feedback is limited."
      }
    ]
  },
  {
    "icon": "in-library",
    "title": "Library imports",
    "summary": "Updated catalogue checks distinguish games from software more reliably.",
    "items": [
      {
        "tag": "fixed",
        "text": "Corrected a classification rule that hid some games while allowing software into libraries, and restored affected game entries."
      }
    ]
  }
];

const RELEASE_1_0_HIGHLIGHTS: Highlight[] = [
  {
    "icon": "shuffle",
    "title": "Game recommendations",
    "text": "Choose a session, mood and goal to get one game with an explanation."
  },
  {
    "icon": "in-library",
    "title": "Library and collections",
    "text": "Import your Steam games, organise collections and view library statistics."
  },
  {
    "icon": "id",
    "title": "Steam sign-in and guest mode",
    "text": "Connect your library or try a sample library. All launch features are free."
  }
];

const RELEASE_1_0_GROUPS: Group[] = [
  {
    "icon": "shuffle",
    "title": "Game recommendations",
    "summary": "The launch release recommends games from your library using your session, mood and goal, with reasons shown alongside each result.",
    "items": [
      {
        "tag": "new",
        "text": "Choose how much time you have, the mood you want and your goal for the session."
      },
      {
        "tag": "new",
        "text": "Draw one game from the eligible matches."
      },
      {
        "tag": "new",
        "text": "See the reasons behind the recommendation."
      },
      {
        "tag": "new",
        "text": "Reroll to get another suggestion."
      }
    ]
  },
  {
    "icon": "in-library",
    "title": "Steam library",
    "summary": "Import your available Steam library data and view it alongside shared catalogue information.",
    "items": [
      {
        "tag": "new",
        "text": "Import owned games, playtime and last-played dates where Steam provides them."
      },
      {
        "tag": "new",
        "text": "View artwork, genres, tags, review information and duration estimates from the game catalogue."
      },
      {
        "tag": "new",
        "text": "Browse your games in the Library and view library statistics."
      },
      {
        "tag": "new",
        "text": "Open a selected game in the Steam client."
      }
    ]
  },
  {
    "icon": "grid",
    "title": "Collections and game controls",
    "summary": "Organise games into collections and manage which ones you want to play next.",
    "items": [
      {
        "tag": "new",
        "text": "Create custom collections or use automatic collections based on library data."
      },
      {
        "tag": "new",
        "text": "Pin games you want to keep in view."
      },
      {
        "tag": "new",
        "text": "Snooze a game to leave it out of upcoming draws."
      }
    ]
  },
  {
    "icon": "id",
    "title": "Access and devices",
    "summary": "Sign in through Steam to connect your library, or use guest mode to try the app with sample games.",
    "items": [
      {
        "tag": "new",
        "text": "Steam OpenID sign-in connects your Steam identity without sharing your password with VaultShuffle."
      },
      {
        "tag": "new",
        "text": "Guest mode lets you try the app without an account."
      },
      {
        "tag": "new",
        "text": "Steam Deck and Mac filters help narrow recommendations by device support."
      },
      {
        "tag": "new",
        "text": "All launch features are available without a paid tier."
      }
    ]
  }
];

function ReleaseHighlights({ items }: { items: Highlight[] }) {
  return (
    <div className={styles.highlights}>
      {items.map((item) => (
        <article key={item.title} className={styles.highlight}>
          <span className={styles.highlightIcon}><VaultIcon name={item.icon} size={20} /></span>
          <div>
            <h3 className={styles.highlightTitle}>{item.title}</h3>
            <p>{item.text}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function ReleaseGroups({ groups }: { groups: Group[] }) {
  return (
    <div className={styles.groups}>
      {groups.map((group) => (
        <section key={group.title} className={styles.group}>
          <div className={styles.groupHead}>
            <VaultIcon name={group.icon} size={17} />
            <h3 className={styles.groupTitle}>{group.title}</h3>
          </div>
          <p className={styles.groupSummary}>{group.summary}</p>
          <ul>
            {[...group.items].sort((a, b) => TAG_ORDER[a.tag] - TAG_ORDER[b.tag]).map((item) => (
              <li key={item.text}>
                <span className={`${styles.tag} ${TAG_CLASS[item.tag]}`}>{item.tag}</span>
                {item.text}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ReleaseBody() {
  return (
    <>
      <section className={styles.releaseOverview} aria-labelledby="release-1-1-overview">
        <div className={styles.overviewInner}>
          <div className={styles.overviewHead}>
            <VaultIcon name="new" size={17} />
            <h3 id="release-1-1-overview" className={styles.overviewTitle}>Release overview</h3>
          </div>
          <p>
            VaultShuffle 1.1 adds family-library imports, global filters and expanded pinned-game displays.
            Library review controls replace the separate Purge page.
          </p>
          <p>
            This update also adds public-profile imports and adjusts recommendations, personalisation and game
            classification. Details are grouped below by feature.
          </p>
        </div>
      </section>

      <ReleaseHighlights items={RELEASE_1_1_HIGHLIGHTS} />
      <ReleaseGroups groups={RELEASE_1_1_GROUPS} />
    </>
  );
}

function LaunchReleaseBody() {
  return (
    <>
      <section className={styles.releaseOverview} aria-labelledby="release-1-0-overview">
        <div className={styles.overviewInner}>
          <div className={styles.overviewHead}>
            <VaultIcon name="new" size={17} />
            <h3 id="release-1-0-overview" className={styles.overviewTitle}>Launch overview</h3>
          </div>
          <p>
            VaultShuffle 1.0 introduced Steam library imports and recommendations based on session, mood and goal.
            Each pick includes an explanation and controls to launch, pin, snooze or draw again.
          </p>
          <p>
            The launch also includes guest mode, collections, library statistics and Steam Deck and Mac filters.
            All features are free to use.
          </p>
        </div>
      </section>

      <ReleaseHighlights items={RELEASE_1_0_HIGHLIGHTS} />
      <ReleaseGroups groups={RELEASE_1_0_GROUPS} />

      <p className={styles.releaseCoda}>
        The <Link href="/faq">FAQ</Link> covers library imports, recommendations and account options.
      </p>
    </>
  );
}

export default function ReleasesPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Product · Updated 4 September 2026"
        title="Releases"
        intro="What's new"
        variant="release"
        sections={[
          { title: "1.1 — 4 September 2026", open: true, body: <ReleaseBody /> },
          {
            title: "1.0 — 29 August 2026",
            body: <LaunchReleaseBody />
          }
        ]}
      />
    </SharedInformationShell>
  );
}
