"use client";

import { useState } from "react";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import styles from "./landing-experience.module.css";

const QUESTIONS = [
  {
    id: "session",
    number: "01",
    title: "What kind of session?",
    options: [
      { label: "Short Session", icon: "short-session" },
      { label: "Evening Session", icon: "evening-session" },
      { label: "Weekend Session", icon: "weekend-session" }
    ]
  },
  {
    id: "mood",
    number: "02",
    title: "What headspace are you in?",
    options: [
      { label: "Brain-Off", icon: "brain-off" },
      { label: "Chill", icon: "chill" },
      { label: "Intense", icon: "intense" }
    ]
  },
  {
    id: "goal",
    number: "03",
    title: "What do you want tonight?",
    options: [
      { label: "Something New", icon: "something-new" },
      { label: "Finish Something", icon: "finish-something" },
      { label: "Surprise Me", icon: "surprise-me" }
    ]
  }
] as const;

type QuestionId = (typeof QUESTIONS)[number]["id"];
type SelectionState = Record<QuestionId, string>;

const SURPRISE_PRESETS: SelectionState[] = [
  { session: "Short Session", mood: "Brain-Off", goal: "Surprise Me" },
  { session: "Evening Session", mood: "Intense", goal: "Finish Something" },
  { session: "Weekend Session", mood: "Chill", goal: "Something New" }
];

/**
 * The question rail and the line underneath that echoes the current setup.
 *
 * These two are one island rather than two because the echo reads the same state
 * the buttons write. They render as siblings inside the section, exactly as they
 * did when the whole page was one component - a fragment adds no wrapper, so the
 * layout is unchanged.
 */
export function LandingQuestions() {
  const [selections, setSelections] = useState<SelectionState>({
    session: "Evening Session",
    mood: "Intense",
    goal: "Finish Something"
  });
  const [surpriseIndex, setSurpriseIndex] = useState(0);

  function choose(question: QuestionId, value: string) {
    setSelections((current) => ({ ...current, [question]: value }));
    trackEvent(ANALYTICS_EVENTS.landingDemoUsed, { control: question, value });
  }

  function surpriseMe() {
    const proposedIndex = (surpriseIndex + 1) % SURPRISE_PRESETS.length;
    const proposedPreset = SURPRISE_PRESETS[proposedIndex];
    const repeatsCurrentChoice = QUESTIONS.every(
      (question) => selections[question.id] === proposedPreset[question.id]
    );
    const nextIndex = repeatsCurrentChoice
      ? (proposedIndex + 1) % SURPRISE_PRESETS.length
      : proposedIndex;

    setSurpriseIndex(nextIndex);
    setSelections(SURPRISE_PRESETS[nextIndex]);
    trackEvent(ANALYTICS_EVENTS.landingDemoUsed, { control: "surprise" });
  }

  return (
    <>
      <div className={styles.questionRail}>
        {QUESTIONS.map((question) => (
          <fieldset key={question.id} className={styles.question}>
            <legend>
              <span>{question.number}</span>
              <strong>{question.title}</strong>
            </legend>
            <div className={styles.options}>
              {question.options.map((option) => {
                const selected = selections[question.id] === option.label;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={selected}
                    className={selected ? styles.optionSelected : styles.option}
                    onClick={() => choose(question.id, option.label)}
                  >
                    <SiteGlyph name={option.icon} size={28} />
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
        <aside className={styles.skipChoice}>
          <span className={styles.skipNode}><SiteGlyph name="shuffle" size={22} /></span>
          <p>Can&apos;t even be bothered choosing those?</p>
          <button type="button" onClick={surpriseMe}>Skip it, just pick something</button>
        </aside>
      </div>
      <p className={styles.primed} aria-live="polite">
        <SiteGlyph name="open-vault" size={21} />
        Vault primed for <strong>{selections.session}</strong><span>·</span><strong>{selections.mood}</strong><span>·</span><strong>{selections.goal}</strong>
      </p>
    </>
  );
}
