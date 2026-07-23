"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import posthog from "posthog-js";
import { createPortal } from "react-dom";
import { ScrollControls } from "@/components/shared/ScrollControls";
import { usePathname } from "next/navigation";
import styles from "./FeedbackProvider.module.css";

type FeedbackType = "improvement" | "bug";
type OpenOptions = { type?: FeedbackType; source?: string };
type FeedbackContextValue = { openFeedback: (options?: OpenOptions) => void };

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function useFeedback() {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedback must be used inside FeedbackProvider.");
  return value;
}

function browserSummary() {
  const agent = navigator.userAgent;
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Edg\//.test(agent)) return "Edge";
  if (/Chrome\//.test(agent)) return "Chrome";
  if (/Safari\//.test(agent)) return "Safari";
  return "Other browser";
}

function appArea(pathname: string) {
  if (pathname.startsWith("/vault")) return "Vault";
  if (pathname.startsWith("/library")) return "Library";
  if (pathname.startsWith("/purge")) return "Purge";
  if (pathname.startsWith("/collections")) return "Collections";
  if (pathname.startsWith("/wishlist")) return "Wishlist";
  if (pathname === "/contact") return "Contact";
  return pathname === "/" ? "Landing" : "Website";
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>("improvement");
  const [source, setSource] = useState("footer");

  const openFeedback = useCallback((options: OpenOptions = {}) => {
    setType(options.type ?? "improvement");
    setSource(options.source ?? "footer");
    setOpen(true);
  }, []);
  const closeFeedback = useCallback(() => setOpen(false), []);

  return (
    <FeedbackContext.Provider value={{ openFeedback }}>
      {children}
      {open ? <FeedbackModal initialType={type} source={source} route={pathname} onClose={closeFeedback} /> : null}
    </FeedbackContext.Provider>
  );
}

function FeedbackModal({ initialType, source, route, onClose }: { initialType: FeedbackType; source: string; route: string; onClose: () => void }) {
  const formStartedAt = useRef(Date.now());
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [type, setType] = useState(initialType);
  const [message, setMessage] = useState("");
  const [contactAllowed, setContactAllowed] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"editing" | "success" | "error">("editing");
  const [error, setError] = useState("");

  useEffect(() => {
    setMounted(true);
    const saved = sessionStorage.getItem("vault-feedback-draft");
    if (saved) {
      try {
        const draft = JSON.parse(saved) as { message?: string; type?: FeedbackType; contactAllowed?: boolean; email?: string };
        setMessage(draft.message ?? "");
        setType(draft.type ?? initialType);
        setContactAllowed(Boolean(draft.contactAllowed));
        setEmail(draft.email ?? "");
      } catch { /* Ignore malformed browser-session drafts. */ }
    }
  }, [initialType]);

  useEffect(() => {
    if (!mounted) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [mounted, onClose, submitting]);

  useEffect(() => {
    if (status !== "editing" || !message) return;
    sessionStorage.setItem("vault-feedback-draft", JSON.stringify({ message, type, contactAllowed, email }));
  }, [message, type, contactAllowed, email, status]);

  const valid = message.trim().length >= 10 && message.trim().length <= 2000 && (!contactAllowed || !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const width = window.innerWidth;
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback_type: type,
          message: message.trim(),
          contact_allowed: contactAllowed,
          contact_email: contactAllowed && email ? email.trim() : null,
          route,
          app_area: appArea(route),
          client_context: {
            viewport: width < 640 ? "mobile" : width < 1024 ? "tablet" : "desktop",
            browser: browserSummary(),
            submitted_at: new Date().toISOString(),
            source
          },
          website: "",
          form_started_at: formStartedAt.current
        })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "We couldn't send your feedback. Please try again.");
      posthog.capture('feedback_submitted', { feedback_type: type, app_area: appArea(route), source });
      sessionStorage.removeItem("vault-feedback-draft");
      setStatus("success");
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "We couldn't send your feedback. Please try again.");
      setStatus("error");
    } finally {
      setSubmitting(false);
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div className={styles.layer}>
      <button className={styles.backdrop} type="button" aria-label="Close feedback" onClick={() => !submitting && onClose()} />
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}><ScrollControls targetRef={dialogRef} axis="vertical" label="Scroll feedback form" />
        <header className={styles.header}>
          <div><p>Help shape the Vault</p><h2 id={titleId}>Share Feedback</h2></div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="Close feedback">×</button>
        </header>
        {status === "success" ? (
          <div className={styles.success} role="status"><span>✓</span><h3>Thanks — your feedback has been sent.</h3><p>Your note is safely with the VaultShuffle team.</p><button type="button" onClick={onClose}>Close</button></div>
        ) : (
          <form onSubmit={submit} className={styles.form}>
            <input type="text" name="website" value="" onChange={() => {}} tabIndex={-1} autoComplete="off" aria-hidden="true" hidden />
            <p className={styles.intro}>What could be better? Spotted a bug? Let us know.</p>
            <div className={styles.segmented} aria-label="Feedback type">
              <button type="button" aria-pressed={type === "improvement"} onClick={() => setType("improvement")}>Improvement</button>
              <button type="button" aria-pressed={type === "bug"} onClick={() => setType("bug")}>Bug Report</button>
            </div>
            <label className={styles.field}><span>Your feedback</span><textarea required minLength={10} maxLength={2000} value={message} onChange={(event) => { setMessage(event.target.value); setStatus("editing"); }} placeholder={type === "bug" ? "What happened, and what did you expect to happen?" : "What feature or experience could be better?"} /><small>{message.length.toLocaleString()} / 2,000</small></label>
            {type === "bug" ? <p className={styles.contextNote}>Basic page and device details are included to help us investigate bugs.</p> : null}
            <label className={styles.checkbox}><input type="checkbox" checked={contactAllowed} onChange={(event) => setContactAllowed(event.target.checked)} /><span>You may contact me about this feedback</span></label>
            {contactAllowed ? <label className={styles.field}><span>Email address <em>Optional</em></span><input type="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label> : null}
            <div className={styles.actions}><button type="button" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" disabled={!valid || submitting}>{submitting ? "Submitting…" : type === "bug" ? "Submit Bug Report" : "Submit Feedback"}</button></div>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}
