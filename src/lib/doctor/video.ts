import fs from "node:fs/promises";

const MAX_MP4_MOOV_BYTES = 32 * 1024 * 1024;

interface Mp4Box {
  type: string;
  start: number;
  payloadStart: number;
  end: number;
}

interface FileBox {
  type: string;
  start: number;
  size: number;
  headerSize: number;
}

export interface Mp4Probe {
  container: "mp4";
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMdat: boolean;
  videoTracks: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  durationSeconds: number | null;
  completeFileRead: boolean;
}

function fourCc(buffer: Buffer, offset: number): string {
  return buffer.toString("ascii", offset, offset + 4);
}

function readBoxes(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = Math.max(0, start);
  const limit = Math.min(end, buffer.length);
  while (offset + 8 <= limit) {
    let size = buffer.readUInt32BE(offset);
    const type = fourCc(buffer, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > limit) break;
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize || offset + size > limit) break;
    boxes.push({
      type,
      start: offset,
      payloadStart: offset + headerSize,
      end: offset + size,
    });
    offset += size;
  }
  return boxes;
}

function child(box: Mp4Box, buffer: Buffer, type: string): Mp4Box | undefined {
  return readBoxes(buffer, box.payloadStart, box.end).find(
    (item) => item.type === type,
  );
}

function parseMdhd(
  buffer: Buffer,
  box: Mp4Box,
): { timescale: number; duration: number } | null {
  const version = buffer[box.payloadStart];
  const offset = version === 1 ? box.payloadStart + 20 : box.payloadStart + 12;
  if (offset + (version === 1 ? 12 : 8) > box.end) return null;
  const timescale = buffer.readUInt32BE(offset);
  const duration =
    version === 1
      ? Number(buffer.readBigUInt64BE(offset + 4))
      : buffer.readUInt32BE(offset + 4);
  return timescale > 0 ? { timescale, duration } : null;
}

function parseTkhd(
  buffer: Buffer,
  box: Mp4Box,
): { width: number; height: number } | null {
  if (box.end - box.payloadStart < 8) return null;
  const widthOffset = box.end - 8;
  return {
    width: buffer.readUInt32BE(widthOffset) / 65_536,
    height: buffer.readUInt32BE(widthOffset + 4) / 65_536,
  };
}

function parseStts(
  buffer: Buffer,
  box: Mp4Box,
): { frames: number; ticks: number } | null {
  if (box.payloadStart + 8 > box.end) return null;
  const count = buffer.readUInt32BE(box.payloadStart + 4);
  let offset = box.payloadStart + 8;
  let frames = 0;
  let ticks = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > box.end) return null;
    const samples = buffer.readUInt32BE(offset);
    const delta = buffer.readUInt32BE(offset + 4);
    frames += samples;
    ticks += samples * delta;
    offset += 8;
  }
  return { frames, ticks };
}

function parseTrack(
  buffer: Buffer,
  track: Mp4Box,
): Omit<
  Mp4Probe,
  | "container"
  | "hasFtyp"
  | "hasMoov"
  | "hasMdat"
  | "completeFileRead"
  | "videoTracks"
> | null {
  const mdia = child(track, buffer, "mdia");
  if (!mdia) return null;
  const handler = child(mdia, buffer, "hdlr");
  if (!handler || handler.payloadStart + 12 > handler.end) return null;
  if (fourCc(buffer, handler.payloadStart + 8) !== "vide") return null;
  const mdhd = child(mdia, buffer, "mdhd");
  const timing = mdhd ? parseMdhd(buffer, mdhd) : null;
  const tkhd = child(track, buffer, "tkhd");
  const dimensions = tkhd ? parseTkhd(buffer, tkhd) : null;
  const minf = child(mdia, buffer, "minf");
  const stbl = minf ? child(minf, buffer, "stbl") : null;
  const stts = stbl ? child(stbl, buffer, "stts") : null;
  const samples = stts ? parseStts(buffer, stts) : null;
  const durationSeconds = timing ? timing.duration / timing.timescale : null;
  const fps =
    samples && timing && samples.ticks > 0
      ? (samples.frames * timing.timescale) / samples.ticks
      : samples && durationSeconds && durationSeconds > 0
        ? samples.frames / durationSeconds
        : null;
  return {
    width: dimensions?.width || null,
    height: dimensions?.height || null,
    fps,
    frames: samples?.frames ?? null,
    durationSeconds,
  };
}

export async function probeMp4(absolutePath: string): Promise<Mp4Probe> {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size < 16)
    throw new Error("empty or too small to be an MP4");
  const file = await fs.open(absolutePath, "r");
  try {
    const topLevel: FileBox[] = [];
    let offset = 0;
    while (offset + 8 <= stat.size && topLevel.length < 100_000) {
      const header = Buffer.alloc(16);
      const firstRead = await file.read(
        header,
        0,
        Math.min(header.length, Number(stat.size) - offset),
        offset,
      );
      if (firstRead.bytesRead < 8) break;
      let size = header.readUInt32BE(0);
      const type = fourCc(header, 4);
      let headerSize = 8;
      if (size === 1) {
        if (firstRead.bytesRead < 16) break;
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(extended);
        headerSize = 16;
      } else if (size === 0) {
        size = Number(stat.size) - offset;
      }
      if (size < headerSize || offset + size > Number(stat.size)) break;
      topLevel.push({ type, start: offset, size, headerSize });
      offset += size;
    }

    const moovBox = topLevel.find((box) => box.type === "moov");
    let tracks: Array<NonNullable<ReturnType<typeof parseTrack>>> = [];
    if (moovBox) {
      if (moovBox.size > MAX_MP4_MOOV_BYTES) {
        throw new Error(
          `moov box exceeds ${MAX_MP4_MOOV_BYTES / 1024 / 1024} MiB probe limit`,
        );
      }
      const moovBuffer = Buffer.alloc(moovBox.size);
      let readOffset = 0;
      while (readOffset < moovBuffer.length) {
        const read = await file.read(
          moovBuffer,
          readOffset,
          moovBuffer.length - readOffset,
          moovBox.start + readOffset,
        );
        if (read.bytesRead === 0) break;
        readOffset += read.bytesRead;
      }
      const parsedMoov = readBoxes(moovBuffer).find(
        (box) => box.type === "moov",
      );
      tracks = parsedMoov
        ? readBoxes(moovBuffer, parsedMoov.payloadStart, parsedMoov.end)
            .filter((box) => box.type === "trak")
            .map((track) => parseTrack(moovBuffer, track))
            .filter((track): track is NonNullable<typeof track> =>
              Boolean(track),
            )
        : [];
    }
    const first = tracks[0];
    return {
      container: "mp4",
      hasFtyp: topLevel.some((box) => box.type === "ftyp"),
      hasMoov: Boolean(moovBox),
      hasMdat: topLevel.some((box) => box.type === "mdat"),
      videoTracks: tracks.length,
      width: first?.width ?? null,
      height: first?.height ?? null,
      fps: first?.fps ?? null,
      frames: first?.frames ?? null,
      durationSeconds: first?.durationSeconds ?? null,
      completeFileRead: offset >= Number(stat.size),
    };
  } finally {
    await file.close();
  }
}
