import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPanelPoint, restorePanelPoint, savePanelPoint } from '../src/floating-panel-position.js';

const desktop = { left: 0, top: 0, width: 1440, height: 900 };
const panel = { width: 320, height: 240 };

test('desktop dragging clamps each edge with the requested margin and keeps interior points', () => {
  assert.deepEqual(clampPanelPoint({ x: -50, y: -90 }, panel, desktop), { x: 8, y: 8 });
  assert.deepEqual(clampPanelPoint({ x: 1440, y: 900 }, panel, desktop), { x: 1112, y: 652 });
  assert.deepEqual(clampPanelPoint({ x: 250, y: 175 }, panel, desktop), { x: 250, y: 175 });
  assert.deepEqual(clampPanelPoint({ x: -1, y: 1000 }, panel, desktop, 16), { x: 16, y: 644 });
});

test('narrow touch viewports anchor oversized panels at the visible start without negative travel', () => {
  const viewport = { left: 0, top: 0, width: 300, height: 200 };
  assert.deepEqual(clampPanelPoint({ x: 200, y: 100 }, panel, viewport), { x: 8, y: 8 });
  assert.deepEqual(savePanelPoint({ x: 200, y: 100 }, panel, viewport), { version: 1, xRatio: 0, yRatio: 0 });
  assert.deepEqual(restorePanelPoint({ version: 1, xRatio: 1, yRatio: 1 }, panel, viewport), { x: 8, y: 8 });
});

test('visual viewport panning and zoom offsets are included at both edges', () => {
  const viewport = { left: 127, top: 213, width: 480, height: 350 };
  assert.deepEqual(clampPanelPoint({ x: 0, y: 0 }, panel, viewport), { x: 135, y: 221 });
  assert.deepEqual(clampPanelPoint({ x: 1000, y: 1000 }, panel, viewport), { x: 279, y: 315 });
  assert.deepEqual(restorePanelPoint({ version: 1, xRatio: .5, yRatio: .5 }, panel, viewport), { x: 207, y: 268 });
});

test('normalized positions round-trip through JSON and preserve relative placement after rotation and panel resize', () => {
  const saved = savePanelPoint({ x: 560, y: 491 }, panel, desktop);
  assert.deepEqual(saved, { version: 1, xRatio: .5, yRatio: .75 });
  assert.deepEqual(restorePanelPoint(JSON.parse(JSON.stringify(saved)), panel, desktop), { x: 560, y: 491 });
  const rotated = { left: 20, top: 40, width: 900, height: 1440 };
  assert.deepEqual(restorePanelPoint(saved, { width: 280, height: 360 }, rotated), { x: 330, y: 846 });
  assert.deepEqual(savePanelPoint({ x: -100, y: 9999 }, panel, desktop), { version: 1, xRatio: 0, yRatio: 1 });
});

test('malformed or hostile persisted coordinates are rejected rather than rendered outside the viewport', () => {
  const invalid: unknown[] = [null, undefined, true, 1, 'stored', [], {}, { version: 2, xRatio: 0, yRatio: 0 },
    { version: '1', xRatio: 0, yRatio: 0 }, { version: 1, xRatio: '0.5', yRatio: 0 },
    { version: 1, xRatio: Infinity, yRatio: 0 }, { version: 1, xRatio: 0, yRatio: NaN },
    { version: 1, xRatio: -.01, yRatio: 0 }, { version: 1, xRatio: 0, yRatio: 1.01 },
    Object.create({ version: 1, xRatio: 0, yRatio: 0 }),
    { get version() { throw new Error('hostile'); }, xRatio: 0, yRatio: 0 }];
  for (const saved of invalid) assert.equal(restorePanelPoint(saved, panel, desktop), null);
});
