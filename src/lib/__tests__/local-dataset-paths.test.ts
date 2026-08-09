import { describe, expect, it } from "bun:test";
import { resolveInsideDataset } from "../local-dataset-paths";

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
