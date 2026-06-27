import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SpeedInsights } from "@vercel/speed-insights/next";

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
      <head>
        <style
          dangerouslySetInnerHTML={{
            __html:
              "html,body{margin:0;min-height:100%;background:#051426;color:#f1f7ff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}img{max-width:100%;}"
          }}
        />
        <link rel="preload" href="/landing.css" as="style" />
        <link rel="preload" href="/styles.css" as="style" />
      </head>
      <body>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
