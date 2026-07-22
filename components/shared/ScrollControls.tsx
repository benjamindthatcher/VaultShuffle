"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./ScrollControls.module.css";

type Props = {
  targetRef: RefObject<HTMLElement | null>;
  axis: "horizontal" | "vertical";
  step?: number;
  className?: string;
  label?: string;
};

export function ScrollControls({ targetRef, axis, step, className = "", label = "Scroll controls" }: Props) {
  const [position, setPosition] = useState({ start: true, end: false });
  const update = useCallback(() => {
    const node = targetRef.current;
    if (!node) return;
    const offset = axis === "horizontal" ? node.scrollLeft : node.scrollTop;
    const visible = axis === "horizontal" ? node.clientWidth : node.clientHeight;
    const total = axis === "horizontal" ? node.scrollWidth : node.scrollHeight;
    setPosition({ start: offset <= 2, end: offset + visible >= total - 2 });
  }, [axis, targetRef]);

  useEffect(() => {
    const node = targetRef.current;
    if (!node) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    node.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); node.removeEventListener("scroll", update); };
  }, [targetRef, update]);

  function move(direction: -1 | 1) {
    const node = targetRef.current;
    if (!node) return;
    const distance = step ?? (axis === "horizontal" ? Math.max(280, node.clientWidth * 0.72) : Math.max(240, node.clientHeight * 0.72));
    node.scrollBy(axis === "horizontal" ? { left: direction * distance, behavior: "smooth" } : { top: direction * distance, behavior: "smooth" });
  }

  const previous = axis === "horizontal" ? "Scroll left" : "Scroll up";
  const next = axis === "horizontal" ? "Scroll right" : "Scroll down";
  return <div className={`${styles.controls} ${axis === "vertical" ? styles.vertical : ""} ${className}`} role="group" aria-label={label}>
    <button type="button" disabled={position.start} onClick={() => move(-1)} aria-label={previous}><VaultIcon name={axis === "horizontal" ? "chevron-left" : "chevron-up"} size={18} /></button>
    <button type="button" disabled={position.end} onClick={() => move(1)} aria-label={next}><VaultIcon name={axis === "horizontal" ? "chevron-right" : "chevron-down"} size={18} /></button>
  </div>;
}
