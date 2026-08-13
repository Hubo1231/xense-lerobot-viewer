import path from "node:path";
import { resolveInsideDataset } from "@/lib/local-dataset-paths";
import { formatStringWithVars } from "@/utils/parquetUtils";
import {
  DoctorCheckBuilder,
  numberValue,
  type LoadedDoctorDataset,
} from "../model";
import { probeMp4 } from "../video";

function resolveVideoPath(
  dataset: LoadedDoctorDataset,
  featureName: string,
  episodeIndex: number,
  raw: Record<string, unknown>,
): string | null {
  const info = dataset.info;
  if (!info?.videoPath) return null;
  const chunk = Math.trunc(
    numberValue(
      raw[`videos/${featureName}/chunk_index`],
      numberValue(raw["5"], Math.floor(episodeIndex / info.chunksSize)),
    ) ?? Math.floor(episodeIndex / info.chunksSize),
  );
  const file = Math.trunc(
    numberValue(
      raw[`videos/${featureName}/file_index`],
      numberValue(raw["6"], numberValue(raw.episode_index, episodeIndex)),
    ) ?? episodeIndex,
  );
  const resolved = formatStringWithVars(info.videoPath, {
    video_key: featureName,
    episode_chunk: chunk.toString().padStart(3, "0"),
    episode_index: file.toString().padStart(6, "0"),
    chunk_index: chunk.toString().padStart(3, "0"),
    file_index: file.toString().padStart(3, "0"),
  });
  return /{[^}]+}/.test(resolved) ? null : resolved;
}

export async function checkVideos(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Video Integrity");
  if (!dataset.info) {
    result.fail("Cannot check videos: info.json not loaded");
    return result.build();
  }
  const features = Object.entries(dataset.info.features).filter(
    ([, spec]) => spec.dtype === "video",
  );
  if (features.length === 0) {
    result.pass("No video features declared -- skipping video checks");
    return result.build();
  }
  if (!dataset.info.videoPath) {
    result.fail("video_path not set in info.json but video features declared");
    return result.build();
  }
  result.pass(
    `Found ${features.length} video feature(s): [${features.map(([name]) => name).join(", ")}]`,
  );
  const inventoryPaths = new Map(
    dataset.inventory.entries.map((entry) => [entry.relPath, entry]),
  );

  for (const [featureName, feature] of features) {
    const groups = new Map<
      string,
      { episodes: number[]; expectedFrames: number }
    >();
    const missing: number[] = [];
    for (const metadata of dataset.episodesMeta) {
      const relPath = resolveVideoPath(
        dataset,
        featureName,
        metadata.episodeIndex,
        metadata.raw,
      );
      if (!relPath) {
        result.warn(
          `${featureName}: Could not resolve video_path template: ${dataset.info.videoPath}`,
        );
        break;
      }
      if (!inventoryPaths.has(relPath)) {
        missing.push(metadata.episodeIndex);
        continue;
      }
      const group = groups.get(relPath) ?? { episodes: [], expectedFrames: 0 };
      group.episodes.push(metadata.episodeIndex);
      group.expectedFrames += metadata.length;
      groups.set(relPath, group);
    }
    if (missing.length > 0) {
      result.fail(
        `${featureName}: ${missing.length} video file(s) missing (episodes [${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}])`,
      );
    } else if (dataset.episodesMeta.length > 0) {
      result.pass(`${featureName}: All video files present`);
    }

    let checked = 0;
    for (const [relPath, group] of [...groups.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (checked >= 20) break;
      checked += 1;
      const absolutePath = resolveInsideDataset(dataset.root, relPath);
      if (!absolutePath) {
        result.fail(`${featureName}: Unsafe video path ${relPath}`);
        continue;
      }
      const extension = path.extname(relPath).toLowerCase();
      if (
        extension !== ".mp4" &&
        extension !== ".m4v" &&
        extension !== ".mov"
      ) {
        result.warn(
          `${featureName}: ${relPath} uses ${extension || "an unknown"} container; structural probe skipped`,
        );
        continue;
      }
      try {
        const probe = await probeMp4(absolutePath);
        if (!probe.hasFtyp || !probe.hasMoov || probe.videoTracks === 0) {
          result.fail(
            `${featureName}: ${relPath} is missing required MP4 metadata or a video track (episodes [${group.episodes.slice(0, 5).join(", ")}])`,
          );
          continue;
        }
        if (!probe.hasMdat && probe.completeFileRead) {
          result.fail(
            `${featureName}: ${relPath} contains no MP4 media-data box`,
          );
        }
        if (
          dataset.info.fps &&
          probe.fps &&
          Math.abs(probe.fps - dataset.info.fps) > 1
        ) {
          result.warn(
            `${featureName}: ${relPath} video fps=${probe.fps.toFixed(1)} != dataset fps=${dataset.info.fps}`,
          );
        }
        const expectedShape = feature.shape;
        if (expectedShape && probe.width && probe.height) {
          if (
            !expectedShape.includes(probe.width) ||
            !expectedShape.includes(probe.height)
          ) {
            result.warn(
              `${featureName}: ${relPath} resolution ${probe.width}x${probe.height} doesn't match shape [${expectedShape.join(", ")}]`,
            );
          }
        }
        if (
          probe.frames &&
          group.expectedFrames > 0 &&
          Math.abs(probe.frames - group.expectedFrames) > 2
        ) {
          result.warn(
            `${featureName}: ${relPath} has ${probe.frames} frames, expected ${group.expectedFrames} from ${group.episodes.length} episode(s)`,
          );
        }
      } catch (error) {
        result.fail(
          `${featureName}: ${relPath} failed structural probe for episodes [${group.episodes.slice(0, 5).join(", ")}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (checked > 0) {
      result.pass(
        `${featureName}: ${checked} video container(s) passed TypeScript structural probing`,
      );
    }
    if (groups.size > 20) {
      result.pass(
        `${featureName}: sampled 20/${groups.size} physical video files for detailed probing`,
      );
    }
  }
  return result.build();
}

export function checkPortability(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Portability");
  if (!dataset.info) {
    result.fail("Cannot check portability: info.json not loaded");
    return result.build();
  }
  const gigabytes = dataset.inventory.totalSize / 1024 ** 3;
  const megabytes = dataset.inventory.totalSize / 1024 ** 2;
  if (gigabytes > 100) {
    result.warn(
      `Dataset is ${gigabytes.toFixed(1)} GB -- very large, consider using a sample for checks`,
    );
  } else if (gigabytes > 10) {
    result.warn(`Dataset is ${gigabytes.toFixed(1)} GB -- large dataset`);
  } else {
    result.pass(`Dataset size: ${megabytes.toFixed(0)} MB`);
  }
  if (dataset.inventory.truncated) {
    result.warn(
      "File inventory was truncated at 100,000 entries; size and portability checks are partial",
    );
  }
  if (dataset.info.dataPath && path.isAbsolute(dataset.info.dataPath)) {
    result.fail(
      `data_path uses absolute path: ${dataset.info.dataPath} -- dataset won't be portable to other machines`,
    );
  }
  if (dataset.info.videoPath && path.isAbsolute(dataset.info.videoPath)) {
    result.fail(
      `video_path uses absolute path: ${dataset.info.videoPath} -- dataset won't be portable to other machines`,
    );
  }
  const symlinks = dataset.inventory.entries.filter((entry) => entry.symlink);
  if (symlinks.length > 0) {
    result.warn(
      `${symlinks.length} symlink(s) found -- may break on different machines: [${symlinks
        .slice(0, 5)
        .map((entry) => entry.relPath)
        .join(", ")}]`,
    );
  }
  const unreadable = dataset.inventory.entries.filter(
    (entry) => !entry.readable,
  );
  if (unreadable.length > 0) {
    result.fail(
      `${unreadable.length} unreadable file(s): [${unreadable
        .slice(0, 5)
        .map((entry) => entry.relPath)
        .join(", ")}]`,
    );
  }
  const nonParquet = dataset.inventory.entries.filter(
    (entry) =>
      entry.relPath.startsWith("data/") && !entry.relPath.endsWith(".parquet"),
  );
  if (nonParquet.length > 0) {
    result.warn(
      `Non-parquet files in data/: [${nonParquet
        .slice(0, 5)
        .map((entry) => entry.relPath)
        .join(", ")}]`,
    );
  }
  const largeFiles = dataset.inventory.entries.filter(
    (entry) => entry.size > 5 * 1024 ** 3,
  );
  if (largeFiles.length > 0) {
    result.warn(
      `${largeFiles.length} file(s) over 5GB (may need git-lfs for HF Hub): [${largeFiles
        .slice(0, 3)
        .map(
          (entry) =>
            `${entry.relPath} (${(entry.size / 1024 ** 3).toFixed(1)} GB)`,
        )
        .join(", ")}]`,
    );
  }
  if (dataset.info.dataPath && !dataset.info.dataPath.includes("{")) {
    result.warn(
      `data_path '${dataset.info.dataPath}' is not a template -- expected a standard LeRobot path template`,
    );
  }
  return result.build();
}
