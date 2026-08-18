/**
 * Locale identity and cookie contract. Pure — no React, no `next/headers` — so
 * both the server helper and the client provider can import it, and so the
 * whole thing is unit-testable.
 */

export const LOCALES = ["en", "zh"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/**
 * Name of the cookie carrying the preference. Read server-side in the root
 * layout so the very first paint is already in the right language, written
 * client-side by the switcher.
 */
export const LOCALE_COOKIE = "xense-locale";

/** One year — a language preference should outlive a browser restart. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/** Anything unrecognised (missing cookie, tampered value) falls back to `en`. */
export function parseLocale(raw: string | null | undefined): Locale {
  if (typeof raw !== "string") return DEFAULT_LOCALE;
  const normalized = raw.trim().toLowerCase();
  return isLocale(normalized) ? normalized : DEFAULT_LOCALE;
}

/** Value for `<html lang>`. `zh` alone is ambiguous; the corpus is Simplified. */
export function htmlLang(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en";
}

/** `document.cookie` payload for persisting a choice. */
export function localeCookieValue(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}
