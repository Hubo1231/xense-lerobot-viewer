import { describe, expect, it } from "bun:test";
import { interpolate, pluralKey } from "../format";

describe("interpolate", () => {
  it("substitutes named placeholders", () => {
    expect(
      interpolate("{count} tasks in {where}", { count: 3, where: "X" }),
    ).toBe("3 tasks in X");
  });

  it("substitutes every occurrence of the same placeholder", () => {
    expect(interpolate("{a}-{a}", { a: "x" })).toBe("x-x");
  });

  it("returns the template untouched when there are no vars", () => {
    expect(interpolate("plain text")).toBe("plain text");
    expect(interpolate("{count} tasks")).toBe("{count} tasks");
  });

  it("leaves an unknown placeholder verbatim rather than blanking it", () => {
    // A missing var is a bug; rendering " tasks" would hide it.
    expect(interpolate("{count} tasks", { other: 1 })).toBe("{count} tasks");
  });

  it("does not treat regular braces as placeholders", () => {
    expect(interpolate("{ not a slot }", { a: 1 })).toBe("{ not a slot }");
  });
});

describe("pluralKey", () => {
  it("splits singular and plural in English", () => {
    expect(pluralKey("home.taskCount", 1, "en")).toBe("home.taskCount_one");
    expect(pluralKey("home.taskCount", 0, "en")).toBe("home.taskCount_other");
    expect(pluralKey("home.taskCount", 2, "en")).toBe("home.taskCount_other");
  });

  it("treats -1 as singular in English", () => {
    expect(pluralKey("home.taskCount", -1, "en")).toBe("home.taskCount_one");
  });

  it("always uses _other in Chinese — there is no plural form", () => {
    for (const count of [0, 1, 2, 100]) {
      expect(pluralKey("home.taskCount", count, "zh")).toBe(
        "home.taskCount_other",
      );
    }
  });
});
