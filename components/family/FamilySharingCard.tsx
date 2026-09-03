"use client";

import { useMemo, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
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
 *
 * The layout earns its own note. The first version put the caveats - estimate,
 * no playtime - in a paragraph above the input, so the card opened by explaining
 * what it would not do to somebody who had not yet done anything. They are the
 * same three facts, but they belong beside the control as reference rather than
 * in front of it as a preamble: the offer leads, the small print sits alongside.
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

export function FamilySharingCard() {
  const {
    familyEnabled,
    familyMembers,
    familyBusy,
    addFamilyMember,
    removeFamilyMember,
    recheckFamilyLibrary,
    isLive,
    allGames
  } = useAppData();

  const [profileInput, setProfileInput] = useState("");
  // Which member is asking "are you sure". Removing one deletes every game only
  // they provide, and the database cascades that to those games' pins, snoozes
  // and collection memberships - none of which come back if the member is added
  // again. That is too much to hang on one unlabelled X.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const familyGameCount = useMemo(
    () => allGames.filter((game) => isFamilyAccess(game.accessSource)).length,
    [allGames]
  );

  if (!familyEnabled || !isLive) return null;

  const atLimit = familyMembers.length >= MAX_FAMILY_MEMBERS;

  async function run(work: () => Promise<string>) {
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await work() });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "That did not work. Please try again." });
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
        {familyGameCount > 0 ? (
          <p className={styles.count} aria-live="polite">
            <span className={styles.countValue}>{familyGameCount}</span>
            <span className={styles.countLabel}>family {familyGameCount === 1 ? "game" : "games"}</span>
          </p>
        ) : null}
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
            <button
              type="button"
              className={styles.recheck}
              disabled={familyBusy}
              onClick={() => run(async () => {
                const counts = await recheckFamilyLibrary();
                return counts.pending
                  ? `${counts.importable} shareable, ${counts.pending} still waiting on Steam store details.`
                  : `${counts.importable} shareable games across your family. Everything has been checked.`;
              })}
            >
              <VaultIcon name="refresh-prices" size={14} />
              Re-check
            </button>
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
                  <a className={styles.memberName} href={member.profileUrl} target="_blank" rel="noreferrer noopener">
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
                      className={styles.confirmYes}
                      disabled={familyBusy}
                      onClick={() => {
                        setConfirmingId(null);
                        void run(async () => {
                          const result = await removeFamilyMember(member.id);
                          const kept = result.retained
                            ? ` ${result.retained} stayed, shared by someone else too.`
                            : "";
                          return `${result.displayName} removed — ${result.removed} ${result.removed === 1 ? "game" : "games"} left your library.${kept}`;
                        });
                      }}
                    >
                      Remove
                    </button>
                    <button type="button" className={styles.confirmNo} onClick={() => setConfirmingId(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.remove}
                    disabled={familyBusy}
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

      {/* The offer and the control on the left, the small print beside it. On a
          phone this collapses to one column and the order still reads: what this
          is, the box you type in, then what to expect from it. */}
      <div className={styles.body}>
        <form
          className={styles.addRow}
          onSubmit={(event) => {
            event.preventDefault();
            const value = profileInput.trim();
            if (!value || familyBusy) return;
            void run(async () => {
              const outcome = await addFamilyMember(value);
              setProfileInput("");
              return outcome.summary;
            });
          }}
        >
          <p className={styles.pitch}>
            {familyMembers.length
              ? "Add another person you share a Steam family with."
              : "Share a Steam family? Add the people in it and their games become yours to draw from."}
          </p>

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
              disabled={familyBusy || atLimit}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className={styles.primary} disabled={familyBusy || atLimit || !profileInput.trim()}>
              <VaultIcon name="add" size={16} />
              {familyBusy ? "Checking…" : "Add"}
            </button>
          </div>
          <p className={styles.hint}>
            {atLimit
              ? `That is all ${MAX_FAMILY_MEMBERS}. A Steam family holds six accounts, including yours.`
              : `Up to ${MAX_FAMILY_MEMBERS} people. Their Steam profile and game details need to be public.`}
          </p>
        </form>

        <aside className={styles.expect} aria-label="What to expect">
          <span className={styles.sectionLabel}>What to expect</span>
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
        </aside>
      </div>
    </section>
  );
}
