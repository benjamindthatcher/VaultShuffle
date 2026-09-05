import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageOpenGraph, pageTwitter } from "@/lib/site";

const description =
  "Contact VaultShuffle for Steam library support, account help, privacy or deletion requests, technical problems, feedback, and partnerships.";

export const metadata: Metadata = {
  title: "Contact Us",
  description,
  alternates: { canonical: "/contact" },
  openGraph: pageOpenGraph({ url: "/contact", title: "Contact Us", description }),
  twitter: pageTwitter({ title: "Contact Us", description })
};
export default function ContactLayout({ children }: { children: ReactNode }) { return children; }
