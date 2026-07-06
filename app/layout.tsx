import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { DEFAULT_THEME_ID, THEME_OPTIONS, THEME_STORAGE_KEY } from "@/lib/themes";

const themeBootScript = `
try {
  var themes = ${JSON.stringify(THEME_OPTIONS.map((theme) => theme.id))};
  var saved = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  document.documentElement.dataset.vaultTheme = themes.indexOf(saved) === -1 ? ${JSON.stringify(DEFAULT_THEME_ID)} : saved;
} catch (error) {
  document.documentElement.dataset.vaultTheme = ${JSON.stringify(DEFAULT_THEME_ID)};
}
`;

export const metadata: Metadata = {
  title: "Vault Shuffle",
  description: "Pick your next Steam game without staring at your backlog all night.",
  icons: {
    icon: "/assets/landing/vaultshuffle-logo-real.png",
    apple: "/assets/landing/vaultshuffle-logo-real.png"
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-vault-theme={DEFAULT_THEME_ID} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <style
          dangerouslySetInnerHTML={{
            __html:
              "html,body{margin:0;min-height:100%;background:#071d2b;color:#f2fbff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}img{max-width:100%;}"
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