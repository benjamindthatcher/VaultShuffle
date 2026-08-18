import type { Metadata } from "next";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
export const metadata: Metadata = { title: "Privacy Policy", description: "How VaultShuffle uses Steam account data, support messages, cookies, and privacy choices.", alternates: { canonical: "/privacy" }, openGraph: { url: "/privacy" } };
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
            body: "VaultShuffle operates this service and is responsible for the personal data described here. Privacy questions, access requests, corrections and deletion requests can be sent to support@vaultshuffle.com or through Contact Us."
          },
          {
            title: "Account and Steam data",
            body: "When you sign in with Steam, we receive your SteamID and public profile details through Steam OpenID. With your public Steam data and the Steam Web API we sync owned game identifiers, titles, playtime and last-played timestamps. We never receive your Steam password. You may also create collections and save notes, progress, pins and game-status choices."
          },
          {
            title: "How and why we use data",
            body: "We use account and game data to authenticate you, maintain your library, calculate progress, provide Vault recommendations, run Purge reviews, keep collections current, prevent abuse, diagnose faults, understand how people use VaultShuffle and respond to support. This processing is necessary to provide the service you request and, for security and service improvement, supports our legitimate interests in operating and improving a reliable product."
          },
          {
            title: "Analytics, account linking and device storage",
            body: "Essential cookies and local storage keep you signed in, remember interface preferences and record your analytics choice. Vercel service telemetry is used for hosting reliability. PostHog product analytics are enabled by default and use first-party cookie and local-storage persistence. When you are signed in, VaultShuffle identifies your PostHog analytics profile using our internal user ID and attaches your SteamID, Steam display name, Steam profile link and avatar where available. PostHog is used for product-usage events, heatmaps, error and performance information, feature analysis and session replay so we can understand how the service is used and improve it. Session replay masks form and input values, although visible interface content and interactions may be recorded. You can turn PostHog analytics off at any time through Analytics Settings."
          },
          {
            title: "Suppliers and international processing",
            body: "We use Steam for sign-in and game data, Supabase for database and authentication infrastructure, Vercel for application hosting and operational telemetry, IGDB for game metadata, and PostHog for product analytics when analytics are enabled. These providers process limited data on our behalf or under their own terms and may operate infrastructure outside the UK."
          },
          {
            title: "Messages, retention and security",
            body: "Contact and feedback submissions are private support records. We keep account and library data while your account is active and retain operational, analytics or support records only as long as reasonably needed for product improvement, support, security, legal obligations and backups. Access is restricted and data is protected with transport encryption and provider access controls, although no online service can promise absolute security."
          },
          {
            title: "Your rights",
            body: "Depending on your location, you may ask for a copy of your personal data, correction, deletion, restriction, portability or an objection to certain processing. You may turn PostHog analytics off at any time through Analytics Settings. UK users may also complain to the Information Commissioner's Office. Contact us first if you would like help exercising a right."
          },
          {
            title: "Changes and age limits",
            body: "VaultShuffle is not directed to children under 13. We may update this notice when the service or its suppliers change; the updated date above shows the current version. Material changes will be made reasonably prominent."
          }
        ]}
      />
    </SharedInformationShell>
  );
}
