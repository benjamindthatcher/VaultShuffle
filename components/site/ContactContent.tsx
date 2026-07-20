"use client";

import { useRef, useState, type FormEvent } from "react";
import { useFeedback } from "@/components/feedback/FeedbackProvider";
import styles from "@/app/contact/contact.module.css";

const enquiryTypes = [
  ["account", "Account support"],
  ["steam-data", "Steam data or syncing"],
  ["privacy", "Privacy or data deletion"],
  ["technical", "Technical problem"],
  ["business", "Business or partnership enquiry"],
  ["other", "Other"]
] as const;

export function ContactContent() {
  const formStartedAt = useRef(Date.now());
  const { openFeedback } = useFeedback();
  const [enquiryType, setEnquiryType] = useState("account");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enquiry_type: enquiryType, email, subject, message, website: "", form_started_at: formStartedAt.current })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "We couldn’t send your message. Please try again.");
      setSuccess(true);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "We couldn’t send your message. Please try again.");
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
            <span>✓</span>
            <h3>Your message has been sent.</h3>
            <p>We’ll get back to you as soon as possible.</p>
            <button type="button" onClick={() => { setSuccess(false); setSubject(""); setMessage(""); }}>Send another message</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <input type="text" name="website" value="" onChange={() => {}} tabIndex={-1} autoComplete="off" aria-hidden="true" hidden />
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
              <span>Subject <small>{subject.length} / 150</small></span>
              <input required minLength={3} maxLength={150} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
            <label>
              <span>Message <small>{message.length.toLocaleString()} / 5,000</small></span>
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
