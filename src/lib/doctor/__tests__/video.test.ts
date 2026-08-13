import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeMp4 } from "../video";

function box(type: string, payload = Buffer.alloc(0)): Buffer {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, "ascii");
  payload.copy(output, 8);
  return output;
}

describe("TypeScript MP4 structural probe", () => {
  it("identifies a structurally incomplete MP4 without native codecs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-mp4-"));
    const file = path.join(directory, "sample.mp4");
    try {
      await fs.writeFile(
        file,
        Buffer.concat([
          box("ftyp", Buffer.from("isom0000", "ascii")),
          box("moov"),
          box("mdat", Buffer.from([0, 1, 2, 3])),
        ]),
      );
      const probe = await probeMp4(file);
      expect(probe.hasFtyp).toBe(true);
      expect(probe.hasMoov).toBe(true);
      expect(probe.hasMdat).toBe(true);
      expect(probe.videoTracks).toBe(0);
      expect(probe.completeFileRead).toBe(true);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
