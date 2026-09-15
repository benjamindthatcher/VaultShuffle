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
  // Someone still signed in can land back here (usually a manual profile that
  // wandered to the landing page). Creating another profile would only fail
  // with session_exists, so offer the way back into their Vault up front.
  const session = await getCurrentSession();
  return <ManualSteamProfileSetup existingVaultName={session?.user.display_name ?? null} />;
}
