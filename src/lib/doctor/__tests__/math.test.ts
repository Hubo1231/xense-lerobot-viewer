import { describe, expect, it } from "bun:test";
import {
  combineMatrices,
  countStandardizedJumps,
  maxConsecutiveEqualRows,
  matrixDiff,
  maxConsecutiveTrue,
  minMax,
  numericMatrix,
  numericVector,
  populationStd,
  summarizeMatrices,
  summarizeMatrixDiffs,
  summaryStandardDeviations,
  valueShape,
} from "../math";

describe("Doctor numeric helpers", () => {
  it("normalizes scalars, BigInt, typed arrays, and nested vectors", () => {
    expect(numericVector(3)).toEqual([3]);
    expect(numericVector(4n)).toEqual([4]);
    expect(numericVector(new Float32Array([1, 2]))).toEqual([1, 2]);
    expect(
      numericVector([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("rejects mixed and ragged matrices", () => {
    expect(
      numericMatrix([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(numericMatrix([[1, 2], [3]])).toBeNull();
    expect(numericMatrix([[1], "bad"])).toBeNull();
  });

  it("combines compatible matrices and computes frame differences", () => {
    expect(
      combineMatrices([
        [[1, 2]],
        [
          [3, 4],
          [5, 7],
        ],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
      [5, 7],
    ]);
    expect(
      matrixDiff([
        [1, 2],
        [3, 5],
        [8, 9],
      ]),
    ).toEqual([
      [2, 3],
      [5, 4],
    ]);
  });

  it("matches NumPy-style population standard deviation", () => {
    expect(populationStd([1, 2, 3])).toBeCloseTo(Math.sqrt(2 / 3));
    expect(maxConsecutiveTrue([false, true, true, false, true])).toBe(2);
  });

  it("describes nested shapes and detects ragged values", () => {
    expect(
      valueShape([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([2, 2]);
    expect(valueShape([[1], [2, 3]])).toBeNull();
  });

  it("streams NumPy-style summaries without flattening large matrices", () => {
    const summary = summarizeMatrices([
      [
        [1, 10],
        [2, 20],
      ],
      [[3, 30]],
    ]);
    expect(summary?.totalRows).toBe(3);
    expect(summary?.dimensionsSummary[0]).toMatchObject({
      count: 3,
      minimum: 1,
      maximum: 3,
      atMinimum: 1,
      atMaximum: 1,
    });
    expect(summary?.dimensionsSummary[0].mean).toBe(2);
    expect(Math.sqrt((summary?.dimensionsSummary[0].m2 ?? 0) / 3)).toBeCloseTo(
      Math.sqrt(2 / 3),
    );
  });

  it("computes global diff statistics and jump/frozen helpers", () => {
    const matrix = [
      [0, 0],
      [0, 0],
      [2, 4],
      [2, 4],
    ];
    const diffs = summarizeMatrixDiffs([matrix]);
    expect(diffs?.totalRows).toBe(3);
    expect(summaryStandardDeviations(diffs!, 1)).toEqual([
      populationStd([0, 2, 0]) || 1,
      populationStd([0, 4, 0]) || 1,
    ]);
    expect(maxConsecutiveEqualRows(matrix)).toBe(1);
    expect(countStandardizedJumps(matrix, [0.1, 0.1])).toBe(1);
  });

  it("finds extrema without spreading a large array into call arguments", () => {
    const values = Array.from({ length: 200_000 }, (_, index) => index - 5);
    expect(minMax(values)).toEqual({ minimum: -5, maximum: 199_994 });
  });
});
