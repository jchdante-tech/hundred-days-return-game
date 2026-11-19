import type { MarketView } from './types.js';

// 0 replaces a value; 1 patches object fields; 2 patches array entries and,
// optionally, changes the length/appends a tail. Historical bars stay on the
// client until they actually change, including the current unfinished bar.
export type ValuePatch =
  | [0, unknown]
  | [1, Record<string, ValuePatch>, string[]?]
  | [2, Record<string, ValuePatch>, number?, unknown[]?];

export interface WireApiResponse {
  market?: MarketView | null;
  ok?: boolean;
  message?: string;
  sync?: { version: string; base?: string; patch?: ValuePatch; unchanged?: true };
}

export interface MarketSnapshot { market: MarketView | null; version?: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Diff public, JSON-shaped DTOs only. Undefined object fields are absent on wire. */
export function diffValues(before: unknown, after: unknown): ValuePatch | undefined {
  if (Object.is(before, after)) return undefined;
  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: Record<string, ValuePatch> = {};
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) {
      const patch = diffValues(before[index], after[index]);
      if (patch) changes[index] = patch;
    }
    const changed = Object.keys(changes).length > 0;
    if (before.length === after.length) return changed ? [2, changes] : undefined;
    return after.length > before.length
      ? [2, changes, after.length, after.slice(shared)]
      : [2, changes, after.length];
  }
  if (isObject(before) && isObject(after)) {
    const changes: Record<string, ValuePatch> = {};
    const removed: string[] = [];
    for (const key of Object.keys(before)) {
      if (before[key] !== undefined && after[key] === undefined) removed.push(key);
    }
    for (const key of Object.keys(after)) {
      if (after[key] === undefined) continue;
      const patch = diffValues(before[key], after[key]);
      if (patch) changes[key] = patch;
    }
    if (removed.length) return [1, changes, removed];
    return Object.keys(changes).length ? [1, changes] : undefined;
  }
  return [0, after];
}

/** Copy changed branches, preserving the previous React snapshot and its arrays. */
export function applyValuePatch(before: unknown, patch: ValuePatch): unknown {
  if (patch[0] === 0) return patch[1];
  if (patch[0] === 2) {
    if (!Array.isArray(before)) throw new Error('Invalid array patch base');
    const next = before.slice();
    for (const [key, change] of Object.entries(patch[1])) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= before.length) throw new Error('Invalid array patch index');
      next[index] = applyValuePatch(before[index], change);
    }
    if (patch[2] !== undefined) {
      const length = patch[2];
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid array patch length');
      if (patch[3]) next.push(...patch[3]);
      if (length > next.length) throw new Error('Missing array patch tail');
      next.length = length;
    }
    return next;
  }
  if (!isObject(before)) throw new Error('Invalid object patch base');
  const next = { ...before };
  for (const key of patch[2] ?? []) delete next[key];
  for (const [key, change] of Object.entries(patch[1])) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Invalid object patch key');
    next[key] = applyValuePatch(before[key], change);
  }
  return next;
}

/** Versions are opaque to callers except for ordering within the same epoch. */
export function compareMarketVersions(first: string | undefined, second: string | undefined): number | undefined {
  if (!first || !second) return undefined;
  const a = first.split(':'), b = second.split(':');
  if (a.length !== 2 || b.length !== 2 || a[0] !== b[0]) return undefined;
  const left = Number(a[1]), right = Number(b[1]);
  return Number.isSafeInteger(left) && Number.isSafeInteger(right) ? Math.sign(left - right) : undefined;
}

/** Undefined asks the caller to fetch a complete view, without replaying actions. */
export function readMarketEnvelope(current: MarketSnapshot, response: WireApiResponse): MarketSnapshot | undefined {
  const sync = response.sync;
  const order = compareMarketVersions(sync?.version, current.version);
  if (order !== undefined && order <= 0) return current;
  if (Object.hasOwn(response, 'market')) {
    return { market: response.market ?? null, version: sync?.version };
  }
  if (!sync) return undefined;
  if (sync.unchanged) return sync.version === current.version ? current : undefined;
  if (!current.market || sync.base !== current.version || !sync.patch) return undefined;
  try {
    return { market: applyValuePatch(current.market, sync.patch) as MarketView, version: sync.version };
  } catch { return undefined; }
}
