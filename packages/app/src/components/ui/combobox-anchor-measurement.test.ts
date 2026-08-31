import { describe, expect, it } from "vitest";

import { readWebAnchorMeasurement } from "./combobox-anchor-measurement";

describe("readWebAnchorMeasurement", () => {
  it("uses DOM viewport coordinates for a visible web anchor", () => {
    const reference = {
      getBoundingClientRect: () => ({ left: 375, top: 1119, width: 177.25 }),
    };

    expect(readWebAnchorMeasurement(reference)).toEqual({ x: 375, y: 1119, width: 177.25 });
  });

  it("falls back when the host is absent, unsupported, or not laid out", () => {
    expect(readWebAnchorMeasurement(null)).toBeNull();
    expect(readWebAnchorMeasurement({})).toBeNull();
    expect(
      readWebAnchorMeasurement({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }) }),
    ).toBeNull();
  });
});
