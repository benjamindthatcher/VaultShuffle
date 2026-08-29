import type { Metadata } from "next";
import Link from "next/link";
import { AnalyticsSettingsLink } from "@/components/site/AnalyticsSettingsLink";
import { InfoPage } from "@/components/site/InfoPage";
import infoStyles from "@/components/site/InfoPage.module.css";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How VaultShuffle uses Steam account data, support messages, cookies, and privacy choices.",
  alternates: { canonical: "/privacy" },
  openGraph: { url: "/privacy" }
};

export default function PrivacyPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Legal · Updated 18 August 2026"
        title="Privacy Policy"
        intro="This notice explains what personal data VaultShuffle uses, where it comes from, why it is needed, and the choices available to you."
        sections={[
          {
            title: "Who is responsible and how to contact us",
            open: true,
            body: (
              <p>
                VaultShuffle operates this service and is responsible for the personal data described here. Privacy
                questions, access requests, corrections and deletion requests can be sent to{" "}
                <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a> or through{" "}
                <Link href="/contact">Contact Us</Link>.
              </p>
            )
          },
          {
            title: "Account and Steam data",
            body: (
              <>
                <p>
                  When you sign in with Steam, we receive your SteamID and public profile details through Steam OpenID.
                  With your public Steam data and the Steam Web API we sync owned game identifiers, titles, playtime and
                  last-played timestamps. We never receive your Steam password.
                </p>
                <p>
                  You may also create collections and save notes, progress, pins and game-status choices. A field-by-field
                  breakdown of what Steam provides is on the <Link href="/steam-data">Steam Data</Link> page.
                </p>
              </>
            )
          },
          {
            title: "How and why we use data",
            body: (
              <>
                <p>We use account and game data to:</p>
                <ul>
                  <li>authenticate you and maintain your library</li>
                  <li>calculate progress and provide Vault recommendations</li>
                  <li>run Purge reviews and keep collections current</li>
                  <li>prevent abuse and diagnose faults</li>
                  <li>understand how people use VaultShuffle, and respond to support</li>
                </ul>
                <p>
                  This processing is necessary to provide the service you request and, for security and service
                  improvement, supports our legitimate interests in operating and improving a reliable product.
                </p>
              </>
            )
          },
          {
            title: "Analytics, account linking and device storage",
            body: (
              <>
                <p>
                  Essential cookies and local storage keep you signed in, remember interface preferences and record your
                  analytics choice. Vercel service telemetry is used for hosting reliability.
                </p>
                <p>
                  PostHog product analytics are on by default and use first-party cookie and local-storage persistence.
                  You are told this on your first visit and can turn them off at any time. When you are signed in,
                  VaultShuffle identifies your PostHog analytics profile using our internal user ID and attaches your
                  SteamID, Steam display name, Steam profile link and avatar where available.
                </p>
                <p>
                  PostHog is used for product-usage events, heatmaps, error and performance information, feature analysis
                  and session replay, so we can understand how the service is used and improve it. Session replay masks
                  form and input values, although visible interface content and interactions may be recorded.
                </p>
                <p>
                  You can turn PostHog analytics off at any time in{" "}
                  <AnalyticsSettingsLink className={infoStyles.inlineAction} />.
                </p>
              </>
            )
          },
          {
            title: "Suppliers and international processing",
            body: (
              <>
                <p>We rely on these providers:</p>
                <ul>
                  <li><strong>Steam</strong> — sign-in and game data</li>
                  <li><strong>Supabase</strong> — database and authentication infrastructure</li>
                  <li><strong>Vercel</strong> — application hosting and operational telemetry</li>
                  <li><strong>IGDB</strong> — game metadata</li>
                  <li><strong>PostHog</strong> — product analytics, when analytics are enabled</li>
                </ul>
                <p>
                  They process limited data on our behalf or under their own terms, and may operate infrastructure
                  outside the UK.
                </p>
              </>
            )
          },
          {
            title: "Messages, retention and security",
            body: (
              <>
                <p>
                  Contact and feedback submissions are private support records. We keep account and library data while
                  your account is active, and retain operational, analytics or support records only as long as reasonably
                  needed for product improvement, support, security, legal obligations and backups.
                </p>
                <p>
                  Access is restricted and data is protected with transport encryption and provider access controls,
                  although no online service can promise absolute security.
                </p>
              </>
            )
          },
          {
            title: "Your rights",
            open: true,
            body: (
              <>
                <p>Depending on your location, you may ask for:</p>
                <ul>
                  <li>a copy of your personal data</li>
                  <li>correction of anything inaccurate</li>
                  <li>deletion, restriction or portability</li>
                  <li>an objection to certain processing</li>
                </ul>
                <p>
                  You may turn PostHog analytics off at any time in{" "}
                  <AnalyticsSettingsLink className={infoStyles.inlineAction} />. To exercise any other right, or if you
                  would like help doing so, email{" "}
                  <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a> or use{" "}
                  <Link href="/contact">Contact Us</Link>.
                </p>
              </>
            )
          },
          {
            title: "Changes and age limits",
            body: (
              <p>
                VaultShuffle is not directed to children under 13. We may update this notice when the service or its
                suppliers change; the updated date above shows the current version. Material changes will be made
                reasonably prominent. Use of the service is also covered by our <Link href="/terms">Terms of Use</Link>.
              </p>
            )
          }
        ]}
      />
    </SharedInformationShell>
  );
}
