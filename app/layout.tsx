import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Vault Shuffle",
  description: "Pick your next Steam game without staring at your backlog all night.",
  icons: {
    icon: "/assets/vault-shuffle-icon.png"
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
