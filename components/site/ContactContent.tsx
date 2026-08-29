"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { useFeedback } from "@/components/feedback/FeedbackProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { announceCooldown } from "@/lib/cooldown";
import styles from "@/app/contact/contact.module.css";

const enquiryTypes = [
  ["account", "Account support"],
  ["steam-data", "Steam data or syncing"],
  ["privacy", "Privacy or data deletion"],
  ["technical", "Technical problem"],
  ["business", "Business or partnership enquiry"],
  ["other", "Other"]
] as const;

const DRAFT_KEY = "vault-contact-draft";

function browserSummary() {
  const agent = navigator.userAgent;
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Edg\//.test(agent)) return "Edge";
  if (/Chrome\//.test(agent)) return "Chrome";
  if (/Safari\//.test(agent)) return "Safari";
  return "Other browser";
}

export function ContactContent() {
  // Stamped on mount rather than during render. Date.now() in a render body is
  // a side effect, and it ran on every render even though only the first was
  // ever used.
  const formStartedAt = useRef(0);
  useEffect(() => {
    formStartedAt.current = Date.now();
  }, []);
  const { openFeedback } = useFeedback();
  const [enquiryType, setEnquiryType] = useState("account");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const successHeadingRef = useRef<HTMLHeadingElement>(null);

  // The feedback dialog has kept a draft for a while; this form allows five
  // thousand characters and kept nothing, so a half-written support message did
  // not survive a stray click. Restored on mount, cleared once it is sent.
  useEffect(() => {
    const saved = sessionStorage.getItem(DRAFT_KEY);
    if (!saved) return;
    try {
      const draft = JSON.parse(saved) as { enquiryType?: string; email?: string; subject?: string; message?: string };
      if (draft.enquiryType) setEnquiryType(draft.enquiryType);
      setEmail(draft.email ?? "");
      setSubject(draft.subject ?? "");
      setMessage(draft.message ?? "");
    } catch { /* Ignore malformed browser-session drafts. */ }
  }, []);

  useEffect(() => {
    if (success) return;
    if (!subject && !message && !email) {
      sessionStorage.removeItem(DRAFT_KEY);
      return;
    }
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ enquiryType, email, subject, message }));
  }, [enquiryType, email, subject, message, success]);

  // The form unmounts when it succeeds, which drops focus to the document body
  // and leaves a keyboard user with no idea where they are. role="status" reads
  // the confirmation out; this puts the caret in it too.
  useEffect(() => {
    if (success) successHeadingRef.current?.focus();
  }, [success]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enquiry_type: enquiryType,
          email,
          subject,
          message,
          client_context: {
            viewport: window.innerWidth < 640 ? "mobile" : window.innerWidth < 1024 ? "tablet" : "desktop",
            browser: browserSummary(),
            submitted_at: new Date().toISOString()
          },
          form_started_at: formStartedAt.current
        })
      });
      const body = await response.json() as { error?: string; code?: string; retry_after_seconds?: number };
      announceCooldown(response, body);
      if (!response.ok) throw new Error(body.error || "We couldn't send your message. Please try again.");
      trackEvent(ANALYTICS_EVENTS.contactSubmitted, { enquiry_type: enquiryType });
      sessionStorage.removeItem(DRAFT_KEY);
      setSuccess(true);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "We couldn't send your message. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className={styles.intro}>
        <p className={styles.eyebrow}>Support</p>
        <h1>Contact Us</h1>
        <p>
          Need help with your account, Steam data or something that cannot be covered by quick feedback? Send us a message.
          All support enquiries are routed to <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a>.
        </p>
        <aside>
          <div>
            <strong>Have a quick suggestion or bug report?</strong>
            <span>Share it without leaving this page.</span>
          </div>
          <button type="button" onClick={() => openFeedback({ source: "contact-callout" })}>Share Feedback</button>
        </aside>
      </section>

      <section className={styles.card} aria-labelledby="contact-form-title">
        <div className={styles.cardHeader}>
          <p>Direct support</p>
          <h2 id="contact-form-title">Send a message</h2>
        </div>
        {success ? (
          <div className={styles.success} role="status">
            <span><VaultIcon name="check" size={27} /></span>
            <h3 ref={successHeadingRef} tabIndex={-1}>Your message has been sent.</h3>
            <p>We&rsquo;ll get back to you as soon as possible.</p>
            <button type="button" onClick={() => { setSuccess(false); setSubject(""); setMessage(""); }}>Send another message</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label>
              <span>Enquiry type</span>
              <select value={enquiryType} onChange={(event) => setEnquiryType(event.target.value)}>
                {enquiryTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>Email address</span>
              <input required type="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
            </label>
            <label>
              <span>Subject <small aria-hidden="true">{subject.length} / 150</small></span>
              <input required minLength={3} maxLength={150} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
            <label>
              <span>Message <small aria-hidden="true">{message.length.toLocaleString()} / 5,000</small></span>
              <textarea required minLength={10} maxLength={5000} value={message} onChange={(event) => setMessage(event.target.value)} />
            </label>
            <button className={styles.submit} type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send Message"}</button>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </form>
        )}
      </section>
    </>
  );
}
