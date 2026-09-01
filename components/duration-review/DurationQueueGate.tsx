"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./DurationReviewInterface.module.css";

export function DurationQueueGate() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isChecking, setIsChecking] = useState(false);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || isChecking) return;
    setIsChecking(true);
    setError("");

    try {
      const response = await fetch("/api/durationqueue/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "The queue could not be unlocked.");
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The queue could not be unlocked.");
      setIsChecking(false);
    }
  }

  return (
    <section className={`${styles.shell} ${styles.gate}`} aria-labelledby="duration-queue-title">
      <div className={styles.gateBrand}>
        <Image src="/assets/brand/vaultshuffle-icon.png" alt="" width={54} height={54} priority />
        <span>Vault<strong>Shuffle</strong></span>
      </div>
      <div className={styles.gateCopy}>
        <h1 id="duration-queue-title">Duration queue</h1>
        <p>A private little game of links, explanations and several thousand Next buttons.</p>
      </div>
      <form className={styles.gateForm} onSubmit={unlock}>
        <label htmlFor="duration-queue-password">Password</label>
        <div className={styles.passwordRow}>
          <input
            id="duration-queue-password"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError("");
            }}
            maxLength={128}
            autoFocus
            disabled={isChecking}
          />
          <button type="submit" disabled={!password || isChecking}>
            {isChecking ? "Checking…" : "Enter"}
            <VaultIcon name="chevron-right" size={17} />
          </button>
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </form>
    </section>
  );
}
