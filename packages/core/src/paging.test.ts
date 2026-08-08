import { describe, expect, it } from 'vitest';
import { boundedLimit, fitTo, probe } from './paging.js';

const BOUNDS = { fallback: 50, max: 200 } as const;

describe('boundedLimit', () => {
  it('passes through a request already in range', () => {
    expect(boundedLimit(75, BOUNDS)).toBe(75);
  });

  it('clamps a request above the maximum', () => {
    expect(boundedLimit(10_000, BOUNDS)).toBe(200);
  });

  it('clamps zero and negatives up to one', () => {
    // Not to the fallback. Somebody asking for none of something is asking a
    // coherent question badly, and answering it with fifty rows would be a
    // larger surprise than answering it with one.
    expect(boundedLimit(0, BOUNDS)).toBe(1);
    expect(boundedLimit(-5, BOUNDS)).toBe(1);
  });

  it('truncates a fraction rather than rounding it', () => {
    // Rounding up would let a caller exceed the maximum by asking for a
    // fraction of a row.
    expect(boundedLimit(10.9, BOUNDS)).toBe(10);
    expect(boundedLimit(200.9, BOUNDS)).toBe(200);
  });

  it('serves the fallback for NaN rather than the maximum', () => {
    // The bug this consolidation fixes. `Number('abc')` is NaN, and without the
    // guard it survives every clamp — `Math.max(NaN, 1)` is NaN — and reaches
    // Prisma as `take: NaN`. Reading it as "everything" would also be wrong: a
    // malformed parameter must not pull the largest page the system allows.
    expect(boundedLimit(Number.NaN, BOUNDS)).toBe(50);
  });

  it('serves the fallback for an infinite request', () => {
    expect(boundedLimit(Number.POSITIVE_INFINITY, BOUNDS)).toBe(50);
    expect(boundedLimit(Number.NEGATIVE_INFINITY, BOUNDS)).toBe(50);
  });
});

describe('probe', () => {
  it('asks for one more row than will be served', () => {
    expect(probe(50)).toBe(51);
  });
});

describe('fitTo', () => {
  it('reports a short list as complete', () => {
    expect(fitTo(['a', 'b'], 5)).toEqual({ items: ['a', 'b'], truncated: false });
  });

  it('reports an empty list as complete', () => {
    expect(fitTo([], 5)).toEqual({ items: [], truncated: false });
  });

  it('reports a list of exactly the limit as complete', () => {
    // The case the probe exists for. Fetched with `probe(3)` and only three came
    // back, so there is nothing beyond them — inferring truncation from a full
    // page would claim rows that do not exist.
    expect(fitTo(['a', 'b', 'c'], 3)).toEqual({
      items: ['a', 'b', 'c'],
      truncated: false,
    });
  });

  it('cuts one row over the limit and says so', () => {
    // Four rows back from `probe(3)` means a fourth exists. It is dropped and
    // its existence reported instead.
    expect(fitTo(['a', 'b', 'c', 'd'], 3)).toEqual({
      items: ['a', 'b', 'c'],
      truncated: true,
    });
  });

  it('cuts a list far over the limit to the limit', () => {
    const rows = Array.from({ length: 100 }, (_, index) => index);
    const page = fitTo(rows, 10);

    expect(page.items).toHaveLength(10);
    expect(page.items.at(-1)).toBe(9);
    expect(page.truncated).toBe(true);
  });
});
