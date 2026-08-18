import type { Locale } from "./config";

export type InterpolationVars = Record<string, string | number>;

/**
 * Replace `{name}` placeholders in a message template.
 *
 * An unknown placeholder is left verbatim rather than blanked: a missing var is
 * a bug worth seeing in the UI, and silently rendering `{count} tasks` as
 * ` tasks` would hide it.
 */
export function interpolate(
  template: string,
  vars?: InterpolationVars,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Pick the `_one` / `_other` variant of a message key.
 *
 * English needs the split ("1 task" / "2 tasks"); Chinese has no plural, so it
 * always takes `_other` and both zh entries are written identically. Encoding
 * this here is what lets the call sites drop the `{n === 1 ? "" : "s"}`
 * ternaries that are sprinkled through the homepage.
 */
export function pluralKey<Base extends string>(
  base: Base,
  count: number,
  locale: Locale,
): `${Base}_one` | `${Base}_other` {
  if (locale === "en" && Math.abs(count) === 1) return `${base}_one`;
  return `${base}_other`;
}
