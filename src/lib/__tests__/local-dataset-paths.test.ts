import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInsideDataset, statDatasetFile } from "../local-dataset-paths";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";

const ROOT = "/data/lerobot/my-dataset";

describe("resolveInsideDataset", () => {
  it("resolves a normal relative file", () => {
    expect(resolveInsideDataset(ROOT, "data/chunk-000/file-000.parquet")).toBe(
      `${ROOT}/data/chunk-000/file-000.parquet`,
    );
  });

  it("accepts pre-split segments", () => {
    expect(resolveInsideDataset(ROOT, "meta", "tasks.parquet")).toBe(
      `${ROOT}/meta/tasks.parquet`,
    );
  });

  it("rejects traversal out of the dataset", () => {
    expect(resolveInsideDataset(ROOT, "../../etc/passwd")).toBeNull();
    expect(resolveInsideDataset(ROOT, "meta/../../secrets")).toBeNull();
  });

  it("rejects absolute segments that would escape the root", () => {
    expect(resolveInsideDataset(ROOT, "/etc/passwd")).toBeNull();
  });

  it("rejects paths that resolve to the root itself", () => {
    expect(resolveInsideDataset(ROOT)).toBeNull();
    expect(resolveInsideDataset(ROOT, ".")).toBeNull();
  });

  it("allows traversal that stays inside the dataset", () => {
    expect(resolveInsideDataset(ROOT, "data/../meta/tasks.parquet")).toBe(
      `${ROOT}/meta/tasks.parquet`,
    );
  });
});

describe("statDatasetFile symlink handling", () => {
  let tmpRoot: string;
  let previousRoot: string | undefined;
  const DATASET = "org/dataset";

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lerobot-paths-"));
    const datasetDir = path.join(tmpRoot, DATASET);
    await fs.mkdir(path.join(datasetDir, "meta"), { recursive: true });

    await fs.writeFile(path.join(datasetDir, "meta", "info.json"), "{}");
    await fs.writeFile(path.join(tmpRoot, "outside.txt"), "secret");

    // A link that leaves the dataset, and one that stays inside it.
    await fs.symlink(
      path.join(tmpRoot, "outside.txt"),
      path.join(datasetDir, "escape.json"),
    );
    await fs.symlink(
      path.join(datasetDir, "meta", "info.json"),
      path.join(datasetDir, "inside.json"),
    );

    previousRoot = process.env.LOCAL_DATASET_ROOT;
    process.env.LOCAL_DATASET_ROOT = tmpRoot;
  });

  afterAll(async () => {
    if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
    else process.env.LOCAL_DATASET_ROOT = previousRoot;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const encoded = () => encodeLocalDatasetPath(DATASET);

  it("stats a plain file inside the dataset", async () => {
    const stat = await statDatasetFile(encoded(), ["meta", "info.json"]);
    expect(stat).not.toBeNull();
    expect(stat?.absolutePath.endsWith("meta/info.json")).toBe(true);
  });

  it("refuses a symlink that points outside the dataset", async () => {
    expect(await statDatasetFile(encoded(), ["escape.json"])).toBeNull();
  });

  it("still follows a symlink that stays inside the dataset", async () => {
    expect(await statDatasetFile(encoded(), ["inside.json"])).not.toBeNull();
  });

  it("returns null for a missing file", async () => {
    expect(await statDatasetFile(encoded(), ["nope.json"])).toBeNull();
  });
});
