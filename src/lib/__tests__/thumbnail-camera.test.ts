import { describe, expect, test } from "bun:test";
import { pickThumbnailVideoKey } from "@/lib/thumbnail-camera";

describe("pickThumbnailVideoKey", () => {
  test("prefers the head camera when present (Xense layout)", () => {
    const keys = [
      "observation.images.head",
      "observation.images.left_wrist",
      "observation.images.right_wrist",
      "observation.images.left_tactile_0",
      "observation.images.right_tactile_0",
    ];
    expect(pickThumbnailVideoKey(keys)).toBe("observation.images.head");
  });

  test("matches any key containing 'head' (case-insensitive, any prefix)", () => {
    // Non-standard head name — Xense/sim1_with_fold_cloth uses images.rgb.head.
    expect(
      pickThumbnailVideoKey([
        "images.rgb.head",
        "images.rgb.hand_left",
        "images.rgb.hand_right",
      ]),
    ).toBe("images.rgb.head");
    // Uppercase / embedded in a longer segment still counts as head.
    expect(
      pickThumbnailVideoKey([
        "observation.images.left_wrist",
        "observation.images.HEAD_center",
      ]),
    ).toBe("observation.images.HEAD_center");
  });

  test("prefers head over wrist even when head is not first", () => {
    expect(
      pickThumbnailVideoKey([
        "observation.images.left_wrist",
        "observation.images.top_head",
      ]),
    ).toBe("observation.images.top_head");
  });

  test("falls back to a wrist camera when there is no head (TacVerse layout)", () => {
    const keys = [
      "observation.images.left_tactile_left",
      "observation.images.left_tactile_right",
      "observation.images.left_wrist",
      "observation.images.right_tactile_left",
      "observation.images.right_tactile_right",
      "observation.images.right_wrist",
    ];
    expect(pickThumbnailVideoKey(keys)).toBe("observation.images.left_wrist");
  });

  test("never picks a tactile stream when a non-tactile camera exists", () => {
    const keys = [
      "observation.images.left_tactile_0",
      "observation.images.exterior",
    ];
    expect(pickThumbnailVideoKey(keys)).toBe("observation.images.exterior");
  });

  test("falls back to the first stream only when every camera is tactile", () => {
    const keys = [
      "observation.images.left_tactile_0",
      "observation.images.right_tactile_0",
    ];
    expect(pickThumbnailVideoKey(keys)).toBe(
      "observation.images.left_tactile_0",
    );
  });

  test("returns null when there are no video streams", () => {
    expect(pickThumbnailVideoKey([])).toBeNull();
  });
});
