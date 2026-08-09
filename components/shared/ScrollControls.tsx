"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./ScrollControls.module.css";

type Props = {
  targetRef: RefObject<HTMLElement | null>;
  axis: "horizontal";
  step?: number;
  className?: string;
  label?: string;
};

export function ScrollControls({ targetRef, axis, step, className = "", label = "Scroll controls" }: Props) {
  const [position, setPosition] = useState({ start: true, end: true });
  const update = useCallback(() => {
    const node = targetRef.current;
    if (!node) {
      setPosition({ start: true, end: true });
      return;
    }
    const offset = node.scrollLeft;
    const visible = node.clientWidth;
    const total = node.scrollWidth;
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
    const distance = step ?? Math.max(280, node.clientWidth * 0.72);
    node.scrollBy({ left: direction * distance, behavior: "smooth" });
  }

  return <div className={`${styles.controls} ${className}`} role="group" aria-label={label}>
    <button type="button" disabled={position.start} onClick={() => move(-1)} aria-label="Scroll left"><VaultIcon name="chevron-left" size={18} /></button>
    <button type="button" disabled={position.end} onClick={() => move(1)} aria-label="Scroll right"><VaultIcon name="chevron-right" size={18} /></button>
  </div>;
}
