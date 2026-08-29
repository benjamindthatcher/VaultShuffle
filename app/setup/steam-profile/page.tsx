import type { Metadata } from "next";
import { ManualSteamProfileSetup } from "@/components/onboarding/ManualSteamProfileSetup";

export const metadata: Metadata = {
  title: "Connect a Public Steam Profile",
  description: "Create a full VaultShuffle profile from a public Steam library without signing in.",
  alternates: { canonical: "/setup/steam-profile" },
  robots: { index: false, follow: false },
};

export default function ManualSteamProfileSetupPage() {
  return <ManualSteamProfileSetup />;
}
