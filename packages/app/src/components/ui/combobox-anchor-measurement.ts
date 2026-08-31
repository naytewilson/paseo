export interface WebAnchorMeasurement {
  x: number;
  y: number;
  width: number;
}

/**
 * Reads the viewport coordinates of a React Native Web host element.
 *
 * React Native Web's `measureInWindow` can report the origin for a host that
 * is rendered through a portal/overlay. The DOM rect is already expressed in
 * viewport coordinates, which is exactly what the desktop popover needs.
 */
export function readWebAnchorMeasurement(reference: unknown): WebAnchorMeasurement | null {
  if (!reference || typeof reference !== "object") return null;
  const getBoundingClientRect = (reference as { getBoundingClientRect?: unknown })
    .getBoundingClientRect;
  if (typeof getBoundingClientRect !== "function") return null;

  const rect = getBoundingClientRect.call(reference) as {
    left?: unknown;
    top?: unknown;
    x?: unknown;
    y?: unknown;
    width?: unknown;
  } | null;
  if (!rect || typeof rect !== "object") return null;
  const x = typeof rect.left === "number" ? rect.left : rect.x;
  const y = typeof rect.top === "number" ? rect.top : rect.y;
  const width = rect.width;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0
  ) {
    return null;
  }
  return { x, y, width };
}
