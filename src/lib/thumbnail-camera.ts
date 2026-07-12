/**
 * Choose which camera's video stream to use as a dataset preview thumbnail.
 *
 * Tactile sensors are also stored as `dtype: "video"` streams, so naively
 * taking the first video feature can surface a tactile image — wrong for a
 * preview (this is exactly what happened for TacVerse datasets, whose first
 * video feature is `observation.images.left_tactile_left`).
 *
 * Preference order (all name checks are loose, case-insensitive substring
 * matches — any key *containing* the word counts, regardless of prefix, e.g.
 * both `observation.images.head` and `images.rgb.head` match "head"):
 *   1. a head camera (contains "head") — Xense datasets,
 *   2. else a wrist camera (contains "wrist") — TacVerse datasets have no head,
 *   3. else any non-tactile camera (never fall back to a tactile stream if a
 *      real camera exists),
 *   4. else the first video stream (last resort — tactile-only datasets).
 *
 * @param videoKeys feature keys whose dtype is "video", in info.json order.
 */
export function pickThumbnailVideoKey(videoKeys: string[]): string | null {
  if (videoKeys.length === 0) return null;
  const match = (re: RegExp) => videoKeys.find((key) => re.test(key));
  return (
    match(/head/i) ??
    match(/wrist/i) ??
    videoKeys.find((key) => !/tactile/i.test(key)) ??
    videoKeys[0]
  );
}
