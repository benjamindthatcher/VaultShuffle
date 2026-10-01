"use client";

import { useMemo, useState } from "react";
import { useAppData, type FamilyMember } from "@/components/app-shell/AppDataProvider";
import { LOCAL_DASHBOARD_PREVIEW } from "@/lib/dashboard-preview";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { FamilyMark } from "@/components/shared/FamilyMark";
import { isFamilyAccess, MAX_FAMILY_MEMBERS } from "@/lib/family-sharing";
import styles from "./FamilySharingCard.module.css";

/**
 * Steam Families, through the front door only.
 *
 * The player adds the Steam profiles of the people they share a family with, and
 * VaultShuffle reads each public library with the same developer key and the
 * same parser the manual-profile onboarding already uses. Nothing here asks for
 * a credential, and nothing here asks the player to go and run anything.
 *
 * There was a second, exact tier that called Steam's own Families API. It needed
 * the player's Steam session token, which Valve will only give to their own
 * browser, so the only shape available was talking somebody through fetching a
 * credential by hand. Dropped: the accuracy did not cover teaching several
 * hundred people that habit.
 */

/**
 * The three things somebody needs to know, in the order they will meet them.
 *
 * The first one shows the actual mark rather than naming it. "Marked with a
 * family icon" tells a person nothing they can act on until they have seen the
 * icon, and this card is the one place they are guaranteed to be looking before
 * their library fills up with games wearing it. It is the real component, not a
 * drawing of it, so the legend cannot go stale.
 */
const EXPECTATIONS = [
  {
    icon: "draw-from-vault" as const,
    text: "Their shareable games join your Library and your draws, marked like this:",
    showsMark: true
  },
  {
    icon: "privacy" as const,
    text: "It is an estimate. Steam can still block a game for reasons a public profile does not show."
  },
  {
    icon: "playtime" as const,
    text: "Playtime stays blank. The only hours that exist belong to whoever owns the game."
  }
];

const PREVIEW_MEMBERS: FamilyMember[] = [
  { id: "preview-1", steamId: "", displayName: "Alex (sample)", avatarUrl: null, profileUrl: "https://steamcommunity.com/", librarySeen: 179, gamesImported: 105, lastSyncedAt: null, lastError: null },
  { id: "preview-2", steamId: "", displayName: "Sam (sample)", avatarUrl: null, profileUrl: "https://steamcommunity.com/", librarySeen: 27, gamesImported: 12, lastSyncedAt: null, lastError: null }
];

export function FamilySharingCard({ preview = false }: { preview?: boolean }) {
  const data = useAppData();
  const localPreview = preview && LOCAL_DASHBOARD_PREVIEW && !data.isLive;
  const [previewMembers, setPreviewMembers] = useState(PREVIEW_MEMBERS);
  const counts = { seen: 206, importable: 113, excluded: 0, pending: 0, alreadyOwned: 0 };
  const previewData = {
    ...data,
    familyEnabled: true,
    familyMembers: previewMembers,
    familyBusy: false,
    addFamilyMember: async (_profile: string) => {
      const member = { ...PREVIEW_MEMBERS[0], id: `preview-${crypto.randomUUID()}`, displayName: "New person (sample)", librarySeen: 0, gamesImported: 0 };
      setPreviewMembers((current) => current.length < MAX_FAMILY_MEMBERS ? [...current, member] : current);
      return { member, counts, summary: "Sample person added locally. Sign in to connect a real Steam family." };
    },
    removeFamilyMember: async (id: string) => {
      setPreviewMembers((current) => current.filter((member) => member.id !== id));
      return { removed: 0, retained: 0, displayName: previewMembers.find((member) => member.id === id)?.displayName ?? "Sample person" };
    },
    recheckFamilyLibrary: async () => counts
  };
  const {
    familyEnabled,
    familyMembers,
    familyBusy,
    addFamilyMember,
    removeFamilyMember,
    recheckFamilyLibrary,
    isLive,
    allGames
  } = localPreview ? previewData : data;

  const [profileInput, setProfileInput] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = familyBusy || busyAction !== null;
  // Confirm losing playable access to a lender's games before removing them.
  // Personal decisions and notes survive independently in V2.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const familyGameCount = useMemo(
    () => localPreview ? (previewMembers.length ? 113 : 0) : data.dataAuthority === "v2" ? data.unfilteredFamilyCount : allGames.filter((game) => isFamilyAccess(game.accessSource)).length,
    [allGames, localPreview, previewMembers.length, data.dataAuthority, data.unfilteredFamilyCount]
  );

  if (!familyEnabled || (!isLive && !localPreview)) return null;

  const atLimit = familyMembers.length >= MAX_FAMILY_MEMBERS;

  async function run(action: string, work: () => Promise<string>) {
    if (busy) return;
    setBusyAction(action);
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await work() });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "That did not work. Please try again." });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="family-sharing-heading">
      <header className={styles.header}>
        <h2 id="family-sharing-heading" className={styles.heading}>
          <VaultIcon name="family" size={18} />
          Family library
          <span className={styles.experimental}>Experimental</span>
        </h2>
        <div className={styles.headerActions}>
          {familyGameCount > 0 ? (
            <p className={styles.count} aria-live="polite">
              <span className={styles.countValue}>{familyGameCount}</span>
              <span className={styles.countLabel}>family {familyGameCount === 1 ? "game" : "games"}</span>
            </p>
          ) : null}
          {familyMembers.length ? (
            <button
              type="button"
              data-vault-control="secondary" aria-busy={busyAction === "refresh"} className={styles.recheck}
              aria-label="Re-check family library"
              title="Re-check family library"
              disabled={busy}
              onClick={() => run("refresh", async () => {
                const counts = await recheckFamilyLibrary();
                return counts.pending
                  ? `${counts.importable} shareable, ${counts.pending} still waiting on Steam store details.`
                  : `${counts.importable} shareable games across your family. Everything has been checked.`;
              })}
            >
              {busyAction === "refresh" ? <span data-control-spinner aria-hidden="true" /> : <SiteGlyph name="refresh-data" size={18} />}
              {busyAction === "refresh" ? "Checking…" : "Re-check"}
            </button>
          ) : null}
        </div>
      </header>

      {message ? (
        <p className={message.tone === "error" ? styles.errorNote : styles.okNote} role="status">
          {message.text}
        </p>
      ) : null}

      {/* Once there are members they are the content, so they come first. An
          empty card goes straight from the heading to the thing you can do. */}
      {familyMembers.length ? (
        <div className={styles.memberBlock}>
          <div className={styles.memberHead}>
            <span className={styles.sectionLabel}>Sharing with you</span>
          </div>
          <ul className={styles.members}>
            {familyMembers.map((member) => (
              <li key={member.id} className={styles.member}>
                {member.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className={styles.avatar} src={member.avatarUrl} alt="" width={36} height={36} />
                ) : (
                  <span className={styles.avatarFallback} aria-hidden="true">
                    <VaultIcon name="family" size={18} />
                  </span>
                )}
                <span className={styles.memberBody}>
                  <a data-vault-control="text" className={styles.memberName} href={member.profileUrl} target="_blank" rel="noreferrer noopener">
                    {member.displayName}
                    <VaultIcon name="external-link" size={13} />
                  </a>
                  <span className={styles.memberMeta}>
                    {confirmingId === member.id
                      ? <span className={styles.confirmCopy}>Removes up to {member.gamesImported} games</span>
                      : <><strong>{member.gamesImported}</strong> shareable of {member.librarySeen} public</>}
                  </span>
                </span>
                {confirmingId === member.id ? (
                  <span className={styles.confirm}>
                    <button
                      type="button"
                      data-vault-control="blacklist" aria-busy={busyAction === member.id} className={styles.confirmYes}
                      disabled={busy}
                      onClick={() => {
                        void run(member.id, async () => {
                          const result = await removeFamilyMember(member.id);
                          setConfirmingId(null);
                          const kept = result.retained
                            ? ` ${result.retained} stayed, shared by someone else too.`
                            : "";
                          return `${result.displayName} removed — ${result.removed} ${result.removed === 1 ? "game" : "games"} left your library.${kept}`;
                        });
                      }}
                    >
                      {busyAction === member.id ? <span data-control-spinner aria-hidden="true" /> : null}
                      {busyAction === member.id ? "Removing…" : "Remove"}
                    </button>
                    <button type="button" data-vault-control="tertiary" className={styles.confirmNo} disabled={busy} onClick={() => setConfirmingId(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-vault-control="tertiary" data-control-size="icon" data-control-tone="danger" className={styles.remove}
                    disabled={busy}
                    aria-label={`Remove ${member.displayName}`}
                    title={`Remove ${member.displayName}`}
                    onClick={() => setConfirmingId(member.id)}
                  >
                    <VaultIcon name="close" size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Keep the form full width; supporting information is available on demand. */}
      <div className={styles.body}>
        <form
          className={styles.addRow}
          onSubmit={(event) => {
            event.preventDefault();
            const value = profileInput.trim();
            if (!value || busy || atLimit) return;
            void run("add", async () => {
              const outcome = await addFamilyMember(value);
              setProfileInput("");
              return outcome.summary;
            });
          }}
        >
          {!familyMembers.length ? (
            <p className={styles.pitch}>Share a Steam family? Add the people in it and their games become yours to draw from.</p>
          ) : null}

          <label className={styles.addLabel} htmlFor="family-profile-input">
            Steam profile URL or 17-digit Steam ID
          </label>
          <div className={styles.addControls}>
            <input
              id="family-profile-input"
              className={styles.input}
              value={profileInput}
              onChange={(event) => setProfileInput(event.target.value)}
              placeholder="https://steamcommunity.com/id/theirname"
              disabled={busy || atLimit}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" data-vault-control="primary" aria-busy={busyAction === "add"} className={styles.primary} disabled={busy || atLimit || !profileInput.trim()}>
              {busyAction === "add" ? <span data-control-spinner aria-hidden="true" /> : <VaultIcon name="add" size={16} />}
              {busyAction === "add" ? "Checking…" : "Add person"}
            </button>
          </div>
          <p className={styles.hint}>
            {atLimit
              ? `That is all ${MAX_FAMILY_MEMBERS}. A Steam family holds six accounts, including yours.`
              : `Up to ${MAX_FAMILY_MEMBERS} people. Their Steam profile and game details need to be public.`}
          </p>
        </form>

        <details className={styles.expect}>
          <summary data-vault-control="disclosure" className={styles.expectToggle}>
            <span>How Family Library works</span>
            <VaultIcon name="chevron-down" size={16} />
          </summary>
          <ul className={styles.expectList}>
            {EXPECTATIONS.map((item) => (
              <li key={item.icon}>
                <VaultIcon name={item.icon} size={15} />
                <span>
                  {item.text}
                  {item.showsMark ? <span className={styles.markSample}><FamilyMark /></span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}
