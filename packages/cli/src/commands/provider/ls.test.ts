import { beforeEach, describe, expect, it, vi } from "vitest";

import { runLsCommand } from "./ls.js";

const mocks = vi.hoisted(() => ({
  tryConnectToDaemon: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  tryConnectToDaemon: mocks.tryConnectToDaemon,
}));

beforeEach(() => {
  mocks.tryConnectToDaemon.mockReset();
});

describe("provider ls evidence contract", () => {
  it("does not label the offline manifest as available when the daemon is unreachable", async () => {
    mocks.tryConnectToDaemon.mockResolvedValue(null);

    const result = await runLsCommand({}, {} as never);

    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.every((entry) => entry.status !== "available")).toBe(true);
    expect(result.data.every((entry) => entry.status === "unknown")).toBe(true);
  });

  it("does not label the manifest as available when the provider snapshot RPC fails", async () => {
    const close = vi.fn(async () => undefined);
    mocks.tryConnectToDaemon.mockResolvedValue({
      getProvidersSnapshot: vi.fn(async () => {
        throw new Error("snapshot unavailable");
      }),
      close,
    });

    const result = await runLsCommand({}, {} as never);

    expect(result.data.every((entry) => entry.status === "unknown")).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps live ready evidence as available", async () => {
    const close = vi.fn(async () => undefined);
    mocks.tryConnectToDaemon.mockResolvedValue({
      getProvidersSnapshot: vi.fn(async () => ({
        entries: [
          {
            provider: "codex",
            label: "Codex",
            status: "ready",
            enabled: true,
            defaultModeId: "default",
            modes: [],
          },
        ],
      })),
      close,
    });

    const result = await runLsCommand({}, {} as never);

    expect(result.data).toEqual([
      expect.objectContaining({ provider: "codex", status: "available" }),
    ]);
    expect(close).toHaveBeenCalledOnce();
  });
});
