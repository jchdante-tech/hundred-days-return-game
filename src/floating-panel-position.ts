export type PanelPoint = { x: number; y: number };
export type PanelSize = { width: number; height: number };
export type PanelViewport = { left: number; top: number; width: number; height: number };
type SavedPanelPoint = { version: 1; xRatio: number; yRatio: number };

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;

function movementRange(size: PanelSize, viewport: PanelViewport, gap = 8) {
  const margin = Math.max(0, finite(gap, 8));
  const left = finite(viewport.left), top = finite(viewport.top);
  const minX = left + margin, minY = top + margin;
  return {
    minX, minY,
    // An oversized panel stays anchored at the visible start rather than
    // acquiring a negative range that pushes its header out of reach.
    width: Math.max(0, Math.max(0, finite(viewport.width)) - Math.max(0, finite(size.width)) - 2 * margin),
    height: Math.max(0, Math.max(0, finite(viewport.height)) - Math.max(0, finite(size.height)) - 2 * margin),
  };
}

export function clampPanelPoint(point: PanelPoint, size: PanelSize, viewport: PanelViewport, gap = 8): PanelPoint {
  const range = movementRange(size, viewport, gap);
  return {
    x: Math.min(range.minX + range.width, Math.max(range.minX, finite(point.x, range.minX))),
    y: Math.min(range.minY + range.height, Math.max(range.minY, finite(point.y, range.minY))),
  };
}

/** Ratios are relative to the space the panel can travel, not the viewport itself. */
export function savePanelPoint(point: PanelPoint, size: PanelSize, viewport: PanelViewport): SavedPanelPoint {
  const range = movementRange(size, viewport), clamped = clampPanelPoint(point, size, viewport);
  return { version: 1,
    xRatio: range.width ? (clamped.x - range.minX) / range.width : 0,
    yRatio: range.height ? (clamped.y - range.minY) / range.height : 0 };
}

export function restorePanelPoint(saved: unknown, size: PanelSize, viewport: PanelViewport): PanelPoint | null {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  try {
    if (!['version', 'xRatio', 'yRatio'].every(key => Object.hasOwn(saved, key))) return null;
    const data = saved as Record<string, unknown>;
    const ratio = (value: unknown): value is number => typeof value === 'number'
      && Number.isFinite(value) && value >= 0 && value <= 1;
    if (data.version !== 1 || !ratio(data.xRatio) || !ratio(data.yRatio)) return null;
    const range = movementRange(size, viewport);
    return { x: range.minX + range.width * data.xRatio, y: range.minY + range.height * data.yRatio };
  } catch {
    // Storage normally comes from JSON; reject hostile getters/proxies as well.
    return null;
  }
}
