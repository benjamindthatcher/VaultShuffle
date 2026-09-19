"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { identifyProductUser } from "@/lib/posthog-client";
import { requestJson } from "@/lib/api-client";
import { CooldownError } from "@/lib/cooldown";
import { readStoredCooldown, saveCooldown } from "@/lib/cooldown-storage";
import { diagnosticId } from "@/lib/diagnostics";
import styles from "./ManualSteamProfileSetup.module.css";

type LookupProfile = {
  display_name: string;
  avatar_url: string | null;
  game_count: number;
  input_type: "steam_id" | "profile_url" | "vanity" | "vanity_url";
};

type LookupResponse = {
  profile: LookupProfile;
  existing_account: {
    display_name: string;
    steam_display_name: string;
    avatar_url: string | null;
  } | null;
  lookup_token: string;
};

type CreateResponse = {
  redirect_to: string;
  sign_in_mode: "created" | "resumed";
  account: {
    id: string;
    steam_id: string;
    account_type: "manual";
    identity_verified: false;
    display_name: string;
    steam_display_name: string;
    avatar_url: string | null;
    game_count: number;
    input_type: LookupProfile["input_type"];
  };
};

export function ManualSteamProfileSetup({
  hasExistingSession = false,
  existingVaultName = null,
}: {
  hasExistingSession?: boolean;
  existingVaultName?: string | null;
}) {
  const router = useRouter();
  const [showCurrentSession, setShowCurrentSession] = useState(hasExistingSession);
  const [profileInput, setProfileInput] = useState("");
  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [vaultName, setVaultName] = useState("");
  const [busy, setBusy] = useState<"lookup" | "create" | null>(null);
  const [error, setError] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const operationId = useRef("");
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    const saved = readStoredCooldown("manual-setup");
    if (saved) setCooldownUntil(saved.until);
  }, []);
  useEffect(() => {
    if (!cooldownSeconds) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  function postJson<T>(url: string, body: Record<string, string>) {
    operationId.current ||= crypto.randomUUID();
    return requestJson<T>(url, { method: "POST", headers: { "X-Vault-Operation-Id": operationId.current }, body: JSON.stringify(body) });
  }

  async function findProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || cooldownSeconds) return;
    setBusy("lookup");
    setError("");
    try {
      const result = await postJson<LookupResponse>("/api/manual-profile/lookup", { profile: profileInput });
      setLookup(result);
      setVaultName(result.existing_account?.display_name ?? result.profile.display_name);
      trackEvent(ANALYTICS_EVENTS.manualProfileLookupSucceeded, {
        input_type: result.profile.input_type,
        ...(result.existing_account ? {} : { game_count: result.profile.game_count }),
        profile_state: result.existing_account ? "existing" : "new",
        replacing_active_session: hasExistingSession,
        operation_id: operationId.current,
      });
    } catch (caught) {
      const failure = normaliseFailure(caught);
      setError(failure.message);
      if (caught instanceof CooldownError) setCooldownUntil(saveCooldown("manual-setup", caught));
      trackEvent(ANALYTICS_EVENTS.manualProfileLookupFailed, { reason: failure.code, request_id: failure.requestId, operation_id: operationId.current });
    } finally {
      setBusy(null);
    }
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookup || busy || cooldownSeconds) return;
    setBusy("create");
    setError("");
    try {
      const result = await postJson<CreateResponse>("/api/manual-profile/create", {
        lookup_token: lookup.lookup_token,
        display_name: vaultName,
      });
      identifyProductUser({
        userId: result.account.id,
        steamId: result.account.steam_id,
        accountType: result.account.account_type,
        identityVerified: result.account.identity_verified,
        displayName: result.account.display_name,
        steamDisplayName: result.account.steam_display_name,
        avatarUrl: result.account.avatar_url,
      });
      if (result.sign_in_mode === "created") {
        trackNavigationEvent(ANALYTICS_EVENTS.manualProfileCreated, {
          account_type: "manual",
          identity_verified: false,
          input_type: result.account.input_type,
          game_count: result.account.game_count,
        });
      } else {
        trackNavigationEvent(ANALYTICS_EVENTS.manualProfileSignedIn, {
          account_type: "manual",
          identity_verified: false,
          input_type: result.account.input_type,
          replacing_active_session: hasExistingSession,
        });
      }
      router.push(result.redirect_to);
    } catch (caught) {
      const failure = normaliseFailure(caught);
      setError(failure.message);
      if (caught instanceof CooldownError) setCooldownUntil(saveCooldown("manual-setup", caught));
      setBusy(null);
    }
  }

  function resetLookup() {
    setLookup(null);
    setVaultName("");
    setError("");
  }

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="VaultShuffle home">
          <Image src="/assets/brand/vaultshuffle-icon.png" alt="" width={42} height={42} priority />
          <span><strong>Vault</strong>Shuffle</span>
        </Link>
        <Link className={styles.back} href="/"><SiteGlyph name="back" size={18} />Back to the landing page</Link>
      </header>

      <div className={styles.shell}>
        <section className={styles.copy} aria-labelledby="manual-profile-title">
          <p className={styles.kicker}>Your library. Your way in.</p>
          <h1 id="manual-profile-title">
            {lookup?.existing_account
              ? <>Vault found.<span>Welcome back.</span></>
              : lookup
                ? <>Library found.<span>Make it yours.</span></>
                : <>Bring your library.<span>Skip the Steam sign‑in.</span></>}
          </h1>
          <p className={styles.lede}>
            {lookup?.existing_account
              ? "This public profile already has a Vault. Sign in with the saved profile and continue where it left off."
              : lookup
                ? "Check the profile, choose how VaultShuffle should know you, then enter the Vault."
                : "Paste a public Steam profile link or ID. You’ll get the full VaultShuffle experience without signing in through Steam."}
          </p>

          <div className={styles.panel}>
            {showCurrentSession ? (
              <div className={styles.confirmForm}>
                <p className={styles.sessionNotice} role="status">
                  <SiteGlyph name="check" size={18} />
                  <span>
                    You’re already signed in to VaultShuffle{existingVaultName ? <> as <strong>{existingVaultName}</strong></> : null} on this device.
                  </span>
                </p>
                <Link className={styles.primaryAction} href="/vault">
                  <SiteGlyph name="open-vault" size={22} />
                  <span>Go to my Vault</span>
                  <SiteGlyph name="chevron-right" size={18} />
                </Link>
                <button
                  className={styles.textAction}
                  type="button"
                  onClick={() => {
                    trackEvent(ANALYTICS_EVENTS.signInStarted, {
                      location: "manual_profile_existing_session",
                      method: "public_profile_url",
                    });
                    setShowCurrentSession(false);
                  }}
                >
                  Sign in with a different profile URL
                </button>
              </div>
            ) : lookup ? (
              <form onSubmit={createProfile} className={styles.confirmForm}>
                <div className={styles.profileFound}>
                  <span className={styles.avatar}>
                    {lookup.profile.avatar_url
                      ? <img src={lookup.profile.avatar_url} alt="" width={72} height={72} />
                      : <SiteGlyph name="user" size={34} />}
                  </span>
                  <span className={styles.profileIdentity}>
                    <strong>{lookup.profile.display_name}</strong>
                    <small><SiteGlyph name="check" size={15} />Public library</small>
                  </span>
                  {lookup.existing_account ? null : (
                    <span className={styles.gameCount}>
                      <strong>{lookup.profile.game_count.toLocaleString()}</strong>
                      <small>{lookup.profile.game_count === 1 ? "game" : "games"} ready to import</small>
                    </span>
                  )}
                </div>

                {lookup.existing_account ? (
                  <p className={styles.sessionNotice} role="status">
                    <SiteGlyph name="check" size={18} />
                    <span>
                      Continue with the saved VaultShuffle profile <strong>{lookup.existing_account.display_name}</strong>. Its games and activity will be available on this device.
                    </span>
                  </p>
                ) : (
                  <label className={styles.field}>
                    <span>Your VaultShuffle name</span>
                    <input
                      value={vaultName}
                      onChange={(event) => setVaultName(event.target.value)}
                      minLength={1}
                      maxLength={80}
                      autoComplete="nickname"
                      required
                      disabled={busy !== null}
                    />
                  </label>
                )}
                <button className={styles.primaryAction} type="submit" disabled={busy !== null || cooldownSeconds > 0 || !vaultName.trim()}>
                  <SiteGlyph name="open-vault" size={22} />
                  <span>{cooldownSeconds
                    ? `Try again in ${cooldownSeconds}s`
                    : busy === "create"
                      ? lookup.existing_account ? "Signing in…" : "Creating your Vault…"
                      : lookup.existing_account ? `Sign in as ${lookup.existing_account.display_name}` : "Create my Vault"}</span>
                  <SiteGlyph name="chevron-right" size={18} />
                </button>
                <button className={styles.textAction} type="button" onClick={resetLookup} disabled={busy !== null}>
                  Use a different profile
                </button>
              </form>
            ) : (
              <form onSubmit={findProfile} className={styles.lookupForm}>
                <label className={styles.field}>
                  <span>Steam profile URL or ID</span>
                  <span className={styles.inputWrap}>
                    <SiteGlyph name="browser" size={20} />
                    <input
                      value={profileInput}
                      onChange={(event) => setProfileInput(event.target.value)}
                      placeholder="steamcommunity.com/id/yourname"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={300}
                      required
                      autoFocus
                      disabled={busy !== null}
                    />
                  </span>
                </label>
                <p className={styles.inputHint}>Profile link, custom profile name, or 17-digit Steam ID</p>
                <button className={styles.primaryAction} type="submit" disabled={busy !== null || cooldownSeconds > 0 || !profileInput.trim()}>
                  <SiteGlyph name="search" size={21} />
                  <span>{cooldownSeconds ? `Try again in ${cooldownSeconds}s` : busy === "lookup" ? "Checking Steam…" : "Find my library"}</span>
                  <SiteGlyph name="chevron-right" size={18} />
                </button>
              </form>
            )}

            {error ? <p className={styles.error} role="alert"><SiteGlyph name="action" size={18} />{error}</p> : null}
            <p className={styles.reassurance}>
              <SiteGlyph name="shield" size={20} />
              <span>{lookup?.existing_account
                ? "Anyone with this public profile link can sign in to this VaultShuffle profile. This does not verify Steam ownership."
                : lookup
                  ? "This public profile link can be used to sign in to the same VaultShuffle profile on any device. It does not verify Steam ownership."
                  : "VaultShuffle only reads information Steam makes public. It never changes your Steam account or asks for your password."}</span>
            </p>
          </div>
        </section>

        <figure className={styles.artwork} aria-label="A public profile link flowing into a vault of game covers">
          <Image
            src="/assets/onboarding/public-profile-vault.png"
            alt=""
            fill
            priority
            sizes="(max-width: 900px) 100vw, 58vw"
          />
        </figure>
      </div>

      <ol className={styles.steps} aria-label="Profile setup progress">
        <li className={!lookup ? styles.activeStep : styles.completeStep}>
          <span>{lookup ? <SiteGlyph name="check" size={19} /> : "1"}</span>
          <div><strong>Find profile</strong><small>{lookup ? "Complete" : "Paste your link or ID"}</small></div>
        </li>
        <li className={lookup ? styles.activeStep : undefined}>
          <span>2</span><div><strong>Check library</strong><small>{lookup ? "You’re here" : "Confirm what Steam shares"}</small></div>
        </li>
        <li>
          <span>3</span><div><strong>Enter the Vault</strong><small>Your library imports next</small></div>
        </li>
      </ol>
    </main>
  );
}

function normaliseFailure(value: unknown) {
  if (value && typeof value === "object") {
    const failure = value as { message?: unknown; code?: unknown; requestId?: unknown };
    return {
      message: typeof failure.message === "string" ? failure.message : "That did not work. Please try again.",
      code: typeof failure.code === "string" ? failure.code : "unknown",
      requestId: diagnosticId(failure.requestId),
    };
  }
  return { message: "That did not work. Please try again.", code: "unknown" };
}
