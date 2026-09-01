"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { isFamilyAccess, MAX_FAMILY_MEMBERS } from "@/lib/family-sharing";
import styles from "./FamilySharingCard.module.css";

/**
 * Steam Families, through the front door only.
 *
 * The player adds the Steam profiles of the people they share a family with,
 * and VaultShuffle reads each public library with the same developer key and the
 * same parser the manual-profile onboarding already uses. Nothing here asks for
 * a credential, and nothing here asks the player to go and run anything.
 *
 * There was a second, exact tier: Steam's own Families API returns precisely
 * what an account can play, but it is authorised by the player's Steam session
 * token rather than by our key, and Valve sends no CORS headers, so the only way
 * to reach it was to talk somebody through fetching a token themselves. It was
 * dropped - the accuracy it bought was not worth teaching several hundred people
 * to handle a Steam credential by hand, and it could not have been verified
 * before shipping either.
 *
 * So what is left says "probably playable", and says so on the same line as the
 * numbers rather than in small print somewhere else.
 */

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
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const viewedRef = useRef(false);

  const familyGameCount = useMemo(
    () => allGames.filter((game) => isFamilyAccess(game.accessSource)).length,
    [allGames]
  );

  useEffect(() => {
    if (!familyEnabled || !isLive || viewedRef.current) return;
    viewedRef.current = true;
    trackEvent(ANALYTICS_EVENTS.familyCardViewed, {
      members: familyMembers.length,
      family_games: familyGameCount
    });
  }, [familyEnabled, isLive, familyMembers.length, familyGameCount]);

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
        <div className={styles.headingGroup}>
          <h2 id="family-sharing-heading" className={styles.heading}>
            <VaultIcon name="family" size={18} />
            Family library
            <span className={styles.experimental}>Experimental</span>
          </h2>
          <p className={styles.subheading}>
            Add the Steam profiles of the people you share a family with. Their shareable games join
            your draws, marked with a family icon. <strong>It is an estimate</strong> — Steam can
            still block a game for reasons a public profile does not show — and playtime stays blank,
            because the only hours that exist belong to whoever owns the game.
          </p>
        </div>
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

      {familyMembers.length ? (
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
                  {member.gamesImported} shareable of {member.librarySeen} public
                </span>
              </span>
              <button
                type="button"
                className={styles.remove}
                disabled={familyBusy}
                aria-label={`Remove ${member.displayName}`}
                onClick={() => run(async () => {
                  await removeFamilyMember(member.id);
                  return `${member.displayName} was removed. Games another member also shares are still there.`;
                })}
              >
                <VaultIcon name="close" size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

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
        <label className={styles.addLabel} htmlFor="family-profile-input">
          Steam profile URL or 17-digit Steam ID
        </label>
        {/* Stacks on a phone: the input needs the whole width to show a profile
            URL, and traffic here is mobile-majority. */}
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
            ? `A Steam family holds six accounts, so this takes ${MAX_FAMILY_MEMBERS} besides your own.`
            : `Up to ${MAX_FAMILY_MEMBERS} people. Their Steam profile and game details need to be public.`}
        </p>
      </form>

      {familyMembers.length ? (
        <button
          type="button"
          className={styles.secondary}
          disabled={familyBusy}
          onClick={() => run(async () => {
            const counts = await recheckFamilyLibrary();
            return counts.pending
              ? `${counts.importable} shareable, ${counts.pending} still waiting on Steam store details.`
              : `${counts.importable} shareable games across your family. Everything has been checked.`;
          })}
        >
          <VaultIcon name="refresh-prices" size={15} />
          Re-check family library
        </button>
      ) : null}
    </section>
  );
}
