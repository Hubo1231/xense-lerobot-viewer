const TYPED_ARRAY_NAMES = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

const numericMatrixCache = new WeakMap<object, number[][] | null>();

function isTypedArray(value: unknown): value is ArrayLike<number | bigint> {
  return (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    TYPED_ARRAY_NAMES.has(value.constructor.name)
  );
}

/** Flatten one parquet cell into a numeric feature vector. */
export function numericVector(value: unknown): number[] | null {
  if (typeof value === "number") return [value];
  if (typeof value === "bigint") return [Number(value)];

  if (Array.isArray(value)) {
    if (value.every((item): item is number => typeof item === "number")) {
      return value;
    }
    if (
      value.every(
        (item): item is number | bigint =>
          typeof item === "number" || typeof item === "bigint",
      )
    ) {
      return value.map(Number);
    }
  }

  const values = Array.isArray(value)
    ? value
    : isTypedArray(value)
      ? Array.from(value)
      : null;
  if (!values) return null;

  const flattened: number[] = [];
  for (const item of values) {
    const nested = numericVector(item);
    if (!nested) return null;
    for (const nestedValue of nested) flattened.push(nestedValue);
  }
  return flattened.length > 0 ? flattened : null;
}

/** Convert a frame column into a rectangular [frames, dimensions] matrix. */
export function numericMatrix(values: unknown[]): number[][] | null {
  if (values.length === 0) return null;
  const cacheable =
    Array.isArray(values[0]) ||
    (ArrayBuffer.isView(values[0]) && !(values[0] instanceof DataView));
  if (cacheable && numericMatrixCache.has(values)) {
    return numericMatrixCache.get(values) ?? null;
  }
  const rows: number[][] = [];
  let dimensions: number | null = null;
  for (const value of values) {
    const row = numericVector(value);
    if (!row || row.length === 0) {
      if (cacheable) numericMatrixCache.set(values, null);
      return null;
    }
    if (dimensions === null) dimensions = row.length;
    if (row.length !== dimensions) {
      if (cacheable) numericMatrixCache.set(values, null);
      return null;
    }
    rows.push(row);
  }
  if (cacheable) numericMatrixCache.set(values, rows);
  return rows;
}

export function combineMatrices(
  matrices: Array<number[][] | null>,
): number[][] | null {
  const usable = matrices.filter((matrix): matrix is number[][] =>
    Boolean(matrix?.length),
  );
  if (usable.length === 0) return null;
  const width = usable[0][0]?.length ?? 0;
  if (
    width === 0 ||
    usable.some((matrix) => matrix.some((row) => row.length !== width))
  ) {
    return null;
  }
  const combined: number[][] = [];
  for (const matrix of usable) {
    for (const row of matrix) combined.push(row);
  }
  return combined;
}

export interface NumericDimensionSummary {
  count: number;
  mean: number;
  m2: number;
  minimum: number;
  maximum: number;
  atMinimum: number;
  atMaximum: number;
}

export interface NumericMatrixSummary {
  dimensions: number;
  totalRows: number;
  finiteRows: number;
  nanCount: number;
  infCount: number;
  dimensionsSummary: NumericDimensionSummary[];
}

function createMatrixSummary(dimensions: number): NumericMatrixSummary {
  return {
    dimensions,
    totalRows: 0,
    finiteRows: 0,
    nanCount: 0,
    infCount: 0,
    dimensionsSummary: Array.from({ length: dimensions }, () => ({
      count: 0,
      mean: 0,
      m2: 0,
      minimum: Number.POSITIVE_INFINITY,
      maximum: Number.NEGATIVE_INFINITY,
      atMinimum: 0,
      atMaximum: 0,
    })),
  };
}

function updateDimension(
  summary: NumericDimensionSummary,
  value: number,
): void {
  summary.count += 1;
  const delta = value - summary.mean;
  summary.mean += delta / summary.count;
  summary.m2 += delta * (value - summary.mean);

  if (value < summary.minimum) {
    summary.minimum = value;
    summary.atMinimum = 1;
  } else if (value === summary.minimum) {
    summary.atMinimum += 1;
  }
  if (value > summary.maximum) {
    summary.maximum = value;
    summary.atMaximum = 1;
  } else if (value === summary.maximum) {
    summary.atMaximum += 1;
  }
}

function updateSummary(summary: NumericMatrixSummary, row: number[]): void {
  summary.totalRows += 1;
  let finite = true;
  for (const value of row) {
    if (Number.isNaN(value)) {
      summary.nanCount += 1;
      finite = false;
    } else if (!Number.isFinite(value)) {
      summary.infCount += 1;
      finite = false;
    }
  }
  if (!finite) return;
  summary.finiteRows += 1;
  for (let dimension = 0; dimension < row.length; dimension += 1) {
    updateDimension(summary.dimensionsSummary[dimension], row[dimension]);
  }
}

/** NumPy-style per-dimension statistics without concatenating/flattening. */
export function summarizeMatrices(
  matrices: Array<number[][] | null>,
): NumericMatrixSummary | null {
  const first = matrices.find((matrix) => Boolean(matrix?.length));
  const dimensions = first?.[0]?.length ?? 0;
  if (dimensions === 0) return null;
  const summary = createMatrixSummary(dimensions);
  for (const matrix of matrices) {
    if (!matrix) continue;
    for (const row of matrix) {
      if (row.length !== dimensions) return null;
      updateSummary(summary, row);
    }
  }
  return summary.totalRows > 0 ? summary : null;
}

/** Global statistics for consecutive frame differences, matching np.diff. */
export function summarizeMatrixDiffs(
  matrices: Array<number[][] | null>,
): NumericMatrixSummary | null {
  const first = matrices.find((matrix) => Boolean(matrix?.length));
  const dimensions = first?.[0]?.length ?? 0;
  if (dimensions === 0) return null;
  const summary = createMatrixSummary(dimensions);
  for (const matrix of matrices) {
    if (!matrix || matrix.length < 2) continue;
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
      const current = matrix[rowIndex];
      const previous = matrix[rowIndex - 1];
      if (current.length !== dimensions || previous.length !== dimensions) {
        return null;
      }
      const diff = new Array<number>(dimensions);
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        diff[dimension] = current[dimension] - previous[dimension];
      }
      updateSummary(summary, diff);
    }
  }
  return summary.totalRows > 0 ? summary : null;
}

export function summaryStandardDeviations(
  summary: NumericMatrixSummary,
  zeroFallback = 0,
): number[] {
  return summary.dimensionsSummary.map((dimension) => {
    const deviation =
      dimension.count > 0 ? Math.sqrt(dimension.m2 / dimension.count) : 0;
    return deviation === 0 ? zeroFallback : deviation;
  });
}

export function minMax(values: number[]): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimum, maximum };
}

export function maxConsecutiveEqualRows(matrix: number[][]): number {
  let longest = 0;
  let current = 0;
  for (let index = 1; index < matrix.length; index += 1) {
    if (rowsEqual(matrix[index], matrix[index - 1])) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function countStandardizedJumps(
  matrix: number[][],
  standardDeviations: number[],
  threshold = 8,
): number {
  let count = 0;
  for (let index = 1; index < matrix.length; index += 1) {
    let total = 0;
    for (let dimension = 0; dimension < matrix[index].length; dimension += 1) {
      const difference =
        matrix[index][dimension] - matrix[index - 1][dimension];
      total += Math.abs(difference / standardDeviations[dimension]);
    }
    if (total / matrix[index].length > threshold) count += 1;
  }
  return count;
}

export function mean(values: number[]): number {
  return values.length === 0
    ? Number.NaN
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function populationStd(values: number[], center = mean(values)): number {
  if (values.length === 0) return Number.NaN;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      values.length,
  );
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function column(matrix: number[][], dimension: number): number[] {
  return matrix.map((row) => row[dimension]);
}

export function finiteRows(matrix: number[][]): number[][] {
  return matrix.filter((row) => row.every(Number.isFinite));
}

export function matrixDiff(matrix: number[][]): number[][] {
  const diffs: number[][] = [];
  for (let row = 1; row < matrix.length; row += 1) {
    diffs.push(matrix[row].map((value, dim) => value - matrix[row - 1][dim]));
  }
  return diffs;
}

export function rowsEqual(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function maxConsecutiveTrue(values: boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (value) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function allClose(
  left: number[],
  right: number[],
  tolerance = 1e-6,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - right[index]) <= tolerance)
  );
}

export function valueShape(value: unknown): number[] | null {
  if (typeof value === "number" || typeof value === "bigint") return [];
  const values = Array.isArray(value)
    ? value
    : isTypedArray(value)
      ? Array.from(value)
      : null;
  if (!values) return null;
  if (values.length === 0) return [0];
  const first = valueShape(values[0]);
  if (!first) return [values.length];
  if (
    values.some((item) => {
      const shape = valueShape(item);
      return !shape || shape.join(",") !== first.join(",");
    })
  ) {
    return null;
  }
  return [values.length, ...first];
}

export function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined);
    return first === undefined
      ? "array<unknown>"
      : `array<${valueKind(first)}>`;
  }
  return typeof value;
}

export function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}
