import type { Metadata } from "next";
import { ManualSteamProfileSetup } from "@/components/onboarding/ManualSteamProfileSetup";
import { getCurrentSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Connect a Public Steam Profile",
  description: "Create a full VaultShuffle profile from a public Steam library without signing in.",
  alternates: { canonical: "/setup/steam-profile" },
  robots: { index: false, follow: false },
};

export default async function ManualSteamProfileSetupPage() {
  // Offer the active Vault first, while still allowing a deliberate account
  // switch. A public-profile URL now works like sign-in on any device.
  const session = await getCurrentSession();
  return (
    <ManualSteamProfileSetup
      hasExistingSession={session !== null}
      existingVaultName={session?.user.display_name ?? null}
    />
  );
}
