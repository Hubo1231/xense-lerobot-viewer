"use client";

import React from "react";
import { LOCALES, type Locale } from "@/i18n/config";
import { useLocale } from "@/context/locale-context";

const OPTION_LABEL: Record<Locale, "lang.en" | "lang.zh"> = {
  en: "lang.en",
  zh: "lang.zh",
};

const OPTION_TITLE: Record<Locale, "lang.switchToEn" | "lang.switchToZh"> = {
  en: "lang.switchToEn",
  zh: "lang.switchToZh",
};

/**
 * Two-segment EN / 中 toggle for the top-right of a page header.
 *
 * `size="bar"` matches the episode viewer's tab strip (which sets its own
 * vertical rhythm); the default suits the homepage headers.
 */
export default function LanguageSwitcher({
  size = "default",
  className = "",
}: {
  size?: "default" | "bar";
  className?: string;
}) {
  const { locale, setLocale, t } = useLocale();

  const cell =
    size === "bar" ? "px-2.5 py-1 text-[11px]" : "px-2.5 py-1 text-xs";

  return (
    <div
      role="group"
      aria-label={t("lang.label")}
      className={`inline-flex shrink-0 overflow-hidden rounded-md border border-white/10 bg-[var(--surface-1)]/60 ${className}`}
    >
      {LOCALES.map((option) => {
        const selected = option === locale;
        return (
          <button
            key={option}
            type="button"
            lang={option === "zh" ? "zh-CN" : "en"}
            onClick={() => setLocale(option)}
            aria-pressed={selected}
            title={t(OPTION_TITLE[option])}
            className={`${cell} font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] ${
              selected
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t(OPTION_LABEL[option])}
          </button>
        );
      })}
    </div>
  );
}
