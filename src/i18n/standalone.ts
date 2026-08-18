import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  parseLocale,
  type Locale,
} from "./config";
import { interpolate, type InterpolationVars } from "./format";
import { MESSAGES, type MessageKey } from "./messages";

/**
 * Translation for client-side modules that are not React components.
 *
 * The fetch clients (`doctorClient`, `syncClient`, …) throw `Error`s whose
 * message is rendered verbatim by whatever panel called them, so those strings
 * are UI — but a plain module cannot call `useT()`. Reading the same cookie the
 * provider writes keeps the two in step without a second source of truth.
 *
 * On the server (no `document`) this falls back to the default locale. That is
 * only reachable from code paths that also run during SSR; the panels that
 * display these messages are all client components.
 */
export function currentLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const match = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`).exec(
    document.cookie,
  );
  return parseLocale(match?.[1]);
}

export function tStandalone(key: MessageKey, vars?: InterpolationVars): string {
  return interpolate(MESSAGES[currentLocale()][key], vars);
}
