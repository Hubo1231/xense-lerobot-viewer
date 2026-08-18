import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  htmlLang,
  isLocale,
  localeCookieValue,
  parseLocale,
} from "../config";

describe("parseLocale", () => {
  it("accepts every supported locale", () => {
    for (const locale of LOCALES) {
      expect(parseLocale(locale)).toBe(locale);
    }
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseLocale("ZH")).toBe("zh");
    expect(parseLocale("  zh  ")).toBe("zh");
  });

  it("falls back for anything unrecognised", () => {
    expect(parseLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(parseLocale(null)).toBe(DEFAULT_LOCALE);
    expect(parseLocale("")).toBe(DEFAULT_LOCALE);
    expect(parseLocale("fr")).toBe(DEFAULT_LOCALE);
    expect(parseLocale("zh-CN")).toBe(DEFAULT_LOCALE);
  });
});

describe("isLocale", () => {
  it("rejects non-strings and unknown values", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(42)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe("htmlLang", () => {
  it("maps zh to the Simplified tag", () => {
    expect(htmlLang("zh")).toBe("zh-CN");
    expect(htmlLang("en")).toBe("en");
  });
});

describe("localeCookieValue", () => {
  it("is site-wide, long-lived and same-site", () => {
    const value = localeCookieValue("zh");
    expect(value.startsWith(`${LOCALE_COOKIE}=zh;`)).toBe(true);
    expect(value).toContain("path=/");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain(`max-age=${60 * 60 * 24 * 365}`);
  });

  it("round-trips through parseLocale", () => {
    for (const locale of LOCALES) {
      const raw = localeCookieValue(locale).split(";")[0].split("=")[1];
      expect(parseLocale(raw)).toBe(locale);
    }
  });
});
