"use client";

import React, { useEffect, useRef, useState } from "react";

type HoverPlayVideoProps = {
  src: string;
  className?: string;
  /** Seconds of preview to play before pausing back at the first frame. */
  maxPreviewSeconds?: number;
};

/**
 * A thumbnail `<video>` that:
 *  - lazy-loads — the `src` (and `preload="metadata"`) is only attached once the
 *    element scrolls near the viewport, so a grid of N cards no longer fires N
 *    metadata requests up front (browsers cap ~6/host, so 81 cards used to queue
 *    into a long stall); and
 *  - plays on hover — it wires mouseenter/leave on its closest `[data-hover-card]`
 *    ancestor (the card `<Link>`/`<button>`), so hovering anywhere on the card
 *    plays even though the video sits behind the overlay/content layers.
 *
 * Shared by the dataset landing (category cards) and the task grid so the
 * hover-play + lazy-load behaviour lives in one place.
 */
export default function HoverPlayVideo({
  src,
  className = "",
  maxPreviewSeconds = 15,
}: HoverPlayVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Once true, the src/metadata is attached and stays attached.
  const [active, setActive] = useState(false);

  // Lazy-load when the card scrolls near the viewport.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || active) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);

  // Hover-to-play, wired to the enclosing card element.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const card = el.closest("[data-hover-card]") ?? el.parentElement;
    if (!card) return;
    const onEnter = () => {
      setActive(true);
      void el.play().catch(() => undefined);
    };
    const onLeave = () => {
      el.pause();
      el.currentTime = 0;
    };
    card.addEventListener("mouseenter", onEnter);
    card.addEventListener("mouseleave", onLeave);
    return () => {
      card.removeEventListener("mouseenter", onEnter);
      card.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <video
      ref={videoRef}
      src={active ? src : undefined}
      className={className}
      loop
      muted
      playsInline
      preload={active ? "metadata" : "none"}
      onTimeUpdate={(e) => {
        const vid = e.currentTarget;
        if (vid.currentTime >= maxPreviewSeconds) {
          vid.pause();
          vid.currentTime = 0;
        }
      }}
    />
  );
}
