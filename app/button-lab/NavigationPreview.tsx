"use client";

import { useState } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./button-lab.module.css";

const destinations = ["Dashboard", "Vault", "Library", "Collections", "Wishlist"];
const navDirections = [
  { id: "underline", name: "Crisp underline", description: "A sharp lavender line draws in. No background wash.", note: "Minimal", hover: "Bright text and a sharp, fine line." },
  { id: "filled", name: "Violet tile", description: "A defined violet surface appears behind the label.", note: "Rejected for app navigation", hover: "A violet tile fades in behind the label." },
  { id: "outline", name: "Fine outline", description: "A clean lavender frame gives the destination an edge.", note: "More structure", hover: "A thin lavender frame appears." },
] as const;

export function NavigationPreview() {
  const [currentPage, setCurrentPage] = useState("Vault");
  const [profileOpen, setProfileOpen] = useState(false);
  const [navDirection, setNavDirection] = useState<typeof navDirections[number]["id"]>("underline");
  const selectedDirection = navDirections.find((direction) => direction.id === navDirection)!;

  return (
    <section id="navigation-preview" className={styles.navigationPreview} aria-labelledby="navigation-title" data-nav-style={navDirection}>
      <div className={styles.sectionHeading}>
        <h2 id="navigation-title"><span>04</span> Find your way</h2>
        <p>Three directions. No glow. No movement.</p>
      </div>
      <div className={styles.navDirections} role="group" aria-label="Navigation design">
        {navDirections.map((direction) => <button
          key={direction.id}
          type="button"
          className={styles.navDirection}
          data-nav-style={direction.id}
          aria-pressed={navDirection === direction.id}
          onClick={() => setNavDirection(direction.id)}
        >
          <span className={styles.navDirectionNote}>{direction.note}<span aria-hidden="true">{navDirection === direction.id ? "✓" : ""}</span></span>
          <strong>{direction.name}</strong>
          <span className={styles.navDirectionDescription}>{direction.description}</span>
          <span className={styles.previewNavLink} data-nav-state="current" aria-hidden="true">Vault</span>
        </button>)}
      </div>
      <div className={styles.navPreviewFrame}>
        <div className={styles.navPreviewHeader}>
          <span className={styles.navPreviewBrand}><VaultIcon name="shuffle" size={21} /> VaultShuffle</span>
          <nav className={styles.previewNav} aria-label="Studio navigation preview">
            {destinations.map((destination) => (
              <a
                key={destination}
                href="#navigation-preview"
                className={styles.previewNavLink}
                aria-current={currentPage === destination ? "page" : undefined}
                onClick={(event) => { event.preventDefault(); setCurrentPage(destination); }}
              >
                {destination}
              </a>
            ))}
          </nav>
          <button
            type="button"
            className={styles.previewProfile}
            aria-expanded={profileOpen}
            aria-controls="studio-profile-preview"
            onClick={() => setProfileOpen(!profileOpen)}
          >
            <span className={styles.previewAvatar}>G</span> Guest
            <VaultIcon name="chevron-down" size={14} />
          </button>
        </div>
        {profileOpen && <div id="studio-profile-preview" className={styles.profilePreviewPanel}>
          <strong>Guest profile preview</strong>
          <span>The pill keeps a clear violet fill and border while open. No account changes.</span>
          <button type="button" className={styles.previewNavLink} onClick={() => setProfileOpen(false)}>Close preview</button>
        </div>}
        <div className={styles.navPreviewBody}>
          <p className={styles.eyebrow}>{selectedDirection.name} · TRY IT BELOW</p>
          <h3 aria-live="polite">{currentPage}</h3>
          <p>{selectedDirection.description} Hover another destination, then click to change the current page. The selected marker stays stronger. Tab through to try keyboard focus.</p>
          <span className={styles.navPreviewHint}>Local preview · these links keep you in Button Studio.</span>
        </div>
      </div>
      <div className={styles.navStateGrid} aria-label="Navigation state comparison">
        {([
          { state: "rest", label: "Resting", description: "Quiet lavender text." },
          { state: "hover", label: "Hover", description: selectedDirection.hover },
          { state: "current", label: "Current page", description: "A persistent, stronger violet marker." },
          { state: "pressed", label: "Pressed", description: "Deeper inset shading. No movement." },
          { state: "focus", label: "Keyboard focus", description: "A clear inset outline." },
        ] as const).map(({ state, label, description }) => <div key={state} className={styles.navStateCard}>
          <span className={styles.stateLabel}>{label}</span>
          <span className={styles.previewNavLink} data-nav-state={state}>Library</span>
          <p>{description}</p>
        </div>)}
      </div>
    </section>
  );
}
