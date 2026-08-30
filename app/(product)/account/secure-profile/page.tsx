import type { Metadata } from "next";
import { SecureManualProfile } from "@/components/account/SecureManualProfile";

export const metadata: Metadata = {
  title: "Secure Your Profile",
  description: "Make a browser-only VaultShuffle profile recoverable with Steam.",
  robots: { index: false, follow: false },
};

type SecureProfilePageProps = {
  searchParams: Promise<{
    error?: string | string[];
    secured?: string | string[];
    status?: string | string[];
  }>;
};

export default async function SecureProfilePage({ searchParams }: SecureProfilePageProps) {
  const params = await searchParams;
  const error = firstValue(params.error);
  const status = firstValue(params.status);
  const securedValue = firstValue(params.secured);
  const secured = securedValue === "1" || securedValue === "true" || status === "secured";

  return <SecureManualProfile errorCode={error} secured={secured} />;
}

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
