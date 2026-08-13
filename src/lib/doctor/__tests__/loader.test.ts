import { describe, expect, it } from "bun:test";
import { selectDoctorEpisodeMeta } from "../loader";

const episodes = [2, 7, 10, 11, 50, 100, 101].map((episodeIndex) => ({
  episodeIndex,
  length: 1,
  raw: {},
}));

describe("Doctor episode scope", () => {
  it("selects a custom inclusive episode_index range", () => {
    expect(
      selectDoctorEpisodeMeta(episodes, null, { start: 10, end: 100 }).map(
        (episode) => episode.episodeIndex,
      ),
    ).toEqual([10, 11, 50, 100]);
  });

  it("keeps the existing first-N behavior without a custom range", () => {
    expect(
      selectDoctorEpisodeMeta(episodes, 3, null).map(
        (episode) => episode.episodeIndex,
      ),
    ).toEqual([2, 7, 10]);
  });
});
