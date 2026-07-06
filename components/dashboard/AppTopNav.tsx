"use client";

import type { SessionPayload } from "@/lib/types";
import { THEME_OPTIONS, type ThemeOptionId } from "@/lib/themes";

export type AppPage = "library" | "wishlist" | "collections";

export function AppTopNav({
  activePage,
  isLoggedIn,
  onImportSteam,
  onLogout,
  onPageChange,
  onThemeChange,
  selectedTheme,
  session,
  settingsOpen,
  setSettingsOpen
}: {
  activePage: AppPage;
  isLoggedIn: boolean;
  onImportSteam: () => void;
  onLogout: () => void;
  onPageChange: (page: AppPage) => void;
  onThemeChange: (theme: ThemeOptionId) => void;
  selectedTheme: ThemeOptionId;
  session: SessionPayload | null;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean | ((current: boolean) => boolean)) => void;
}) {
  return (
    <header className="top-nav redesign-top-nav">
      <a className="brand-lockup" href="/" aria-label="Vault Shuffle home">
        <img src="/assets/vault-shuffle-mark.svg" alt="" />
        <strong>Vault Shuffle</strong>
      </a>

      <nav className="primary-nav" aria-label="Primary">
        {(["library", "wishlist", "collections"] as const).map((page) => (
          <button
            aria-current={activePage === page ? "page" : undefined}
            className="primary-nav-link"
            key={page}
            onClick={() => onPageChange(page)}
            type="button"
          >
            {page[0].toUpperCase() + page.slice(1)}
          </button>
        ))}
      </nav>

      <div className="nav-actions compact-actions">
        <div className="settings-wrap user-menu-wrap">
          <button
            className={`steam-profile user-menu-button ${settingsOpen ? "active" : ""}`}
            onClick={() => setSettingsOpen((open) => !open)}
            type="button"
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
          >
            {isLoggedIn && session?.avatar_url ? <img src={session.avatar_url} alt="" /> : <span className="steam-avatar-fallback">{isLoggedIn ? "S" : "?"}</span>}
            <span>{isLoggedIn ? session?.display_name || "Steam user" : "Preview mode"}</span>
            <b aria-hidden="true">⌄</b>
          </button>
          {settingsOpen ? (
            <div className="settings-menu user-dropdown" role="menu">
              <button className="menu-action" onClick={onImportSteam} type="button">
                {isLoggedIn ? "Sync Steam" : "Sign in with Steam"}
              </button>
              {isLoggedIn ? <button className="menu-action" onClick={onLogout} type="button">Sign out</button> : null}
              <div className="menu-divider" />
              <strong>Theme</strong>
              <div className="settings-theme-grid compact-theme-grid" role="list" aria-label="Theme options">
                {THEME_OPTIONS.map((theme) => (
                  <button
                    key={theme.id}
                    className={`settings-theme-tile theme-${theme.id} ${selectedTheme === theme.id ? "active" : ""}`}
                    onClick={() => onThemeChange(theme.id)}
                    type="button"
                    aria-pressed={selectedTheme === theme.id}
                  >
                    <span aria-hidden="true" />
                    <b>{theme.name}</b>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
