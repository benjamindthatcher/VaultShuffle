import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
export const metadata: Metadata = { title: "Steam Data", description: "What Steam data VaultShuffle syncs, how it is used, and how to request corrections or deletion.", alternates: { canonical: "/steam-data" }, openGraph: { url: "/steam-data" } };
export default function SteamDataPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Data · Updated 29 August 2026"
        title="Steam Data"
        intro="This page describes the Steam information VaultShuffle requests, how each field is used, and what can prevent a complete sync."
        sections={[
          {
            title: "Sign-in and public-profile data",
            open: true,
            body: (
              <>
                <p>
                  Steam OpenID confirms your SteamID and returns you to VaultShuffle after authentication. We may then read
                  public profile details such as display name and avatar. Steam handles your credentials directly;
                  VaultShuffle never receives or stores your Steam password.
                </p>
                <p>
                  Alternatively, you can submit a public Steam profile URL, custom profile name or SteamID. We resolve it
                  through Steam&apos;s API and create a separate, unverified VaultShuffle profile for that public library.
                  Providing a URL does not sign in to, prove ownership of or change the Steam account.
                </p>
              </>
            )
          },
          {
            title: "Owned library fields",
            open: true,
            body: (
              <>
                <p>For each visible owned app, Steam may provide:</p>
                <ul>
                  <li>an app ID and title</li>
                  <li>total playtime</li>
                  <li>a last-played timestamp</li>
                </ul>
                <p>
                  VaultShuffle combines those with store and catalogue metadata such as genres, artwork, release
                  information, pricing and estimated duration. Your own status, notes, progress, pins and collections are
                  VaultShuffle data rather than Steam data.
                </p>
              </>
            )
          },
          {
            title: "What the data powers",
            body: (
              <ul>
                <li><strong>App IDs</strong> — identify games consistently</li>
                <li><strong>Playtime and last-played</strong> — Library sorting, recent activity, Purge eligibility and progress estimates</li>
                <li><strong>Genres and duration</strong> — narrow Vault draws alongside your Session, Mood and Goal</li>
                <li><strong>Store metadata</strong> — artwork and accurate game details</li>
              </ul>
            )
          },
          {
            title: "Privacy settings and missing games",
            body: (
              <>
                <p>
                  Steam can only return fields available through your account&apos;s privacy settings and its APIs. These
                  may be absent, or deliberately quarantined:
                </p>
                <ul>
                  <li>games whose details are private</li>
                  <li>family-shared titles</li>
                  <li>removed apps</li>
                  <li>demos, tools, dedicated servers and test applications</li>
                </ul>
                <p>A sync can therefore differ from the desktop Steam client.</p>
              </>
            )
          },
          {
            title: "Refreshes and corrections",
            body: (
              <p>
                VaultShuffle refreshes changing metadata periodically, and may refresh your owned-library data after
                connection, a periodic refresh or a manual sync. Steam remains the source for owned-game playtime and
                last-played values. If a Steam value is wrong, confirm it in Steam first; if VaultShuffle has not caught
                up, refresh the library or{" "}
                <Link href="/contact">contact support</Link>.
              </p>
            )
          },
          {
            title: "Deletion and disconnection",
            body: (
              <p>
                Signing out removes this browser&apos;s access to the VaultShuffle profile. To stop periodic syncing and
                request deletion of your VaultShuffle profile, Steam identifiers, library copy and associated preferences, email{" "}
                <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a> or use{" "}
                <Link href="/contact">Contact Us</Link>. Deleting VaultShuffle data does not alter your Steam account.
                What else we hold, and why, is in the <Link href="/privacy">Privacy Policy</Link>.
              </p>
            )
          },
          {
            title: "Independent service",
            body: (
              <p>
                VaultShuffle is not affiliated with or endorsed by Valve. Steam names, artwork and data remain the
                property of their respective owners, and are subject to Steam&apos;s availability, privacy controls and
                terms.
              </p>
            )
          }
        ]}
      />
    </SharedInformationShell>
  );
}
