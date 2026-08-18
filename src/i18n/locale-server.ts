import { cookies } from "next/headers";
import { LOCALE_COOKIE, parseLocale, type Locale } from "./config";

/**
 * The locale for this request, from the cookie the switcher writes.
 *
 * Read in the root layout so the first paint is already in the right language
 * and `<html lang>` is correct without a client round trip. Reading a cookie
 * opts the layout into dynamic rendering — every page here is already
 * `force-dynamic` (the dataset scan hits the filesystem), so nothing is lost.
 */
export async function getServerLocale(): Promise<Locale> {
  const store = await cookies();
  return parseLocale(store.get(LOCALE_COOKIE)?.value);
}
