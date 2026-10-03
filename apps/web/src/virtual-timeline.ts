/** Geometry is independent of the DOM so ordering, anchoring and window bounds are testable. */
export interface RowGeometry { id: string; estimate: number }
export interface RowMeasurement { height: number; width: number }
export interface ScrollAnchor { id: string; offset: number }
export interface TimelineLayout {
  ids: readonly string[];
  offsets: readonly number[];
  index: ReadonlyMap<string, number>;
  total: number;
}

export function timelineLayout(rows: readonly RowGeometry[], measurements: ReadonlyMap<string, RowMeasurement>,
  width: number): TimelineLayout {
  const offsets = [0];
  const ids: string[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    const measurement = measurements.get(row.id);
    const height = measurement && Math.abs(measurement.width - width) < 1
      ? measurement.height : row.estimate;
    index.set(row.id, ids.length);
    ids.push(row.id);
    offsets.push(offsets[offsets.length - 1] + Math.max(1, height));
  }
  return { ids, offsets, index, total: offsets[offsets.length - 1] };
}

export function rowAt(layout: TimelineLayout, offset: number): number {
  let low = 0;
  let high = layout.ids.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (layout.offsets[mid + 1] <= offset) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, Math.max(0, layout.ids.length - 1));
}

export function visibleRange(layout: TimelineLayout, top: number, height: number, overscan = 600) {
  if (!layout.ids.length) return { start: 0, end: 0 };
  return { start: rowAt(layout, Math.max(0, top - overscan)),
    end: Math.min(layout.ids.length, rowAt(layout, top + height + overscan) + 1) };
}

export function captureAnchor(layout: TimelineLayout, top: number): ScrollAnchor | null {
  if (!layout.ids.length) return null;
  const index = rowAt(layout, Math.max(0, top));
  return { id: layout.ids[index], offset: top - layout.offsets[index] };
}

export function restoreAnchor(layout: TimelineLayout, anchor: ScrollAnchor | null): number | null {
  if (!anchor) return null;
  const index = layout.index.get(anchor.id);
  if (index === undefined) return null;
  const height = layout.offsets[index + 1] - layout.offsets[index];
  return layout.offsets[index] + Math.min(anchor.offset, height - 1);
}
