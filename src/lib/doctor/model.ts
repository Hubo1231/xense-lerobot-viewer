import type {
  DoctorCheckResult,
  DoctorEpisodeRange,
  DoctorMessage,
  DoctorSeverity,
} from "@/types/doctor.types";

export type DoctorRawRow = Record<string, unknown>;

export interface DoctorFeatureSpec {
  dtype?: string;
  shape?: number[];
  names?: unknown;
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DoctorDatasetInfo {
  raw: DoctorRawRow;
  codebaseVersion: string | null;
  formatVersion: "v2" | "v3" | null;
  fps: number | null;
  totalEpisodes: number | null;
  totalFrames: number | null;
  totalTasks: number | null;
  chunksSize: number;
  features: Record<string, DoctorFeatureSpec>;
  dataPath: string | null;
  videoPath: string | null;
  splits: Record<string, unknown>;
  robotType: string | null;
}

export interface DoctorEpisodeMeta {
  episodeIndex: number;
  length: number;
  raw: DoctorRawRow;
}

export interface DoctorEpisodeData {
  episodeIndex: number;
  columns: Record<string, unknown[]>;
  length: number;
}

export interface DoctorInventoryEntry {
  relPath: string;
  size: number;
  mtimeMs: number;
  readable: boolean;
  symlink: boolean;
}

export interface DoctorInventory {
  entries: DoctorInventoryEntry[];
  totalSize: number;
  truncated: boolean;
}

export interface LoadedDoctorDataset {
  root: string;
  displayPath: string;
  info: DoctorDatasetInfo | null;
  infoError: string | null;
  episodesMeta: DoctorEpisodeMeta[];
  sampledEpisodesMeta: DoctorEpisodeMeta[];
  totalEpisodeMetaEntries: number;
  episodesData: DoctorEpisodeData[];
  tasks: DoctorRawRow[] | null;
  tasksError: string | null;
  stats: DoctorRawRow | null;
  statsError: string | null;
  inventory: DoctorInventory;
  maxEpisodesApplied: number | null;
  episodeRangeApplied: DoctorEpisodeRange | null;
  loadWarnings: string[];
}

const SEVERITY_RANK: Record<DoctorSeverity, number> = {
  PASS: 0,
  WARN: 1,
  FAIL: 2,
};

/** Mutable only while a single check is being assembled. */
export class DoctorCheckBuilder {
  private severity: DoctorSeverity = "PASS";
  private readonly messages: DoctorMessage[] = [];

  constructor(private readonly name: string) {}

  pass(message: string): void {
    this.add("PASS", message);
  }

  warn(message: string): void {
    this.add("WARN", message);
  }

  fail(message: string): void {
    this.add("FAIL", message);
  }

  add(severity: DoctorSeverity, message: string): void {
    this.messages.push({ severity, message });
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[this.severity]) {
      this.severity = severity;
    }
  }

  build(): DoctorCheckResult {
    return {
      name: this.name,
      severity: this.severity,
      messages: [...this.messages],
    };
  }
}

export function numberValue(
  value: unknown,
  fallback: number | null,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : fallback;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  return fallback;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function isRecord(value: unknown): value is DoctorRawRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function throwIfDoctorAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Doctor run aborted", "AbortError");
  }
}
