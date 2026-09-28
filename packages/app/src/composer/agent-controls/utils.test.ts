import { describe, expect, it } from "vitest";
import {
  getFeatureHighlightColor,
  getFeatureTooltip,
  getAgentControlHintKey,
  normalizeModelId,
  parseRuntimeThinkingOption,
  resolveAgentModelSelection,
} from "./utils";

describe("getAgentControlHintKey", () => {
  it("returns translation keys for each editable agent control hint", () => {
    expect(getAgentControlHintKey("thinking")).toBe("agentControls.hints.thinking");
    expect(getAgentControlHintKey("model")).toBe("agentControls.hints.model");
    expect(getAgentControlHintKey("mode")).toBe("agentControls.hints.mode");
  });
});

describe("feature metadata helpers", () => {
  it("prefers explicit feature tooltip copy", () => {
    expect(
      getFeatureTooltip({
        label: "Plan",
        tooltip: "Toggle plan mode",
      }),
    ).toBe("Toggle plan mode");
  });

  it("falls back to the feature label when no tooltip is provided", () => {
    expect(
      getFeatureTooltip({
        label: "Custom",
      }),
    ).toBe("Custom");
  });

  it("maps feature highlight colors by feature id", () => {
    expect(getFeatureHighlightColor("fast_mode")).toBe("yellow");
    expect(getFeatureHighlightColor("plan_mode")).toBe("blue");
    expect(getFeatureHighlightColor("other")).toBe("default");
  });
});

describe("normalizeModelId", () => {
  it("treats empty values as unset", () => {
    expect(normalizeModelId("")).toBeNull();
    expect(normalizeModelId(undefined)).toBeNull();
  });

  it("returns trimmed model ids", () => {
    expect(normalizeModelId(" gpt-5.1-codex ")).toBe("gpt-5.1-codex");
    expect(normalizeModelId(" default ")).toBe("default");
  });
});

describe("resolveAgentModelSelection", () => {
  it("resolves a configured model alias to its canonical catalog model", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          provider: "claude",
          id: "claude-fable-5",
          aliases: ["claude-fable-5[1m]"],
          label: "Fable 5",
          thinkingOptions: [{ id: "high", label: "High" }],
          defaultThinkingOptionId: "high",
        },
      ],
      runtimeModelId: null,
      configuredModelId: "claude-fable-5[1m]",
      explicitThinkingOptionId: null,
    });

    expect(selection.activeModelId).toBe("claude-fable-5");
    expect(selection.displayModel).toBe("Fable 5");
    expect(selection.selectedThinkingId).toBe("high");
  });

  it("prefers runtime model over configured model", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          thinkingOptions: [{ id: "low", label: "Low" }],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: "a",
      configuredModelId: "b",
      explicitThinkingOptionId: null,
    });

    expect(selection.activeModelId).toBe("a");
    expect(selection.displayModel).toBe("Model A");
    expect(selection.selectedThinkingId).toBe("low");
  });

  it("uses explicit thinking option when provided", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: "a",
      configuredModelId: null,
      explicitThinkingOptionId: "high",
    });

    expect(selection.selectedThinkingId).toBe("high");
    expect(selection.displayThinking).toBe("High");
  });

  it("formats raw thinking labels in the selected model display", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "claude",
          label: "Model A",
          thinkingOptions: [
            { id: "none", label: "none" },
            { id: "xhigh", label: "xhigh" },
          ],
        },
      ],
      runtimeModelId: "a",
      configuredModelId: null,
      explicitThinkingOptionId: "xhigh",
    });

    expect(selection.selectedThinkingId).toBe("xhigh");
    expect(selection.displayThinking).toBe("Extra high");
  });

  it("falls back to the provider default model label instead of Auto", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          isDefault: true,
          thinkingOptions: [{ id: "low", label: "Low" }],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: null,
      configuredModelId: null,
      explicitThinkingOptionId: null,
    });

    expect(selection.displayModel).toBe("Model A");
    expect(selection.displayThinking).toBe("Low");
  });

  it("prefers the configured model when runtime model is not in the model list", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "default",
          provider: "claude",
          label: "Default (Sonnet 4.6)",
          isDefault: true,
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
          ],
        },
      ],
      runtimeModelId: "claude-sonnet-4-6-20260101",
      configuredModelId: "default",
      explicitThinkingOptionId: null,
    });

    expect(selection.activeModelId).toBe("default");
    expect(selection.displayModel).toBe("Default (Sonnet 4.6)");
    expect(selection.selectedThinkingId).toBe("low");
    expect(selection.displayThinking).toBe("Low");
  });
});

describe("resolveAgentModelSelection model-specific contracts (V6)", () => {
  const disjointModels = [
    {
      id: "model-a",
      provider: "v6",
      label: "Model A",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
      ],
      defaultThinkingOptionId: "low",
    },
    {
      id: "model-b",
      provider: "v6",
      label: "Model B",
      thinkingOptions: [
        { id: "high", label: "High" },
        { id: "xhigh", label: "xhigh" },
      ],
      defaultThinkingOptionId: "xhigh",
    },
    {
      id: "model-c",
      provider: "v6",
      label: "Model C",
    },
  ];

  it("exposes only the selected model's reasoning choices", () => {
    const selection = resolveAgentModelSelection({
      models: disjointModels,
      runtimeModelId: "model-a",
      configuredModelId: null,
      explicitThinkingOptionId: null,
    });

    expect(selection.thinkingOptions?.map((option) => option.id)).toEqual(["low", "medium"]);
    expect(selection.selectedThinkingId).toBe("low");
  });

  it("does not leak stale effort across disjoint models", () => {
    const selection = resolveAgentModelSelection({
      models: disjointModels,
      runtimeModelId: "model-b",
      configuredModelId: null,
      explicitThinkingOptionId: "low",
    });

    expect(selection.thinkingOptions?.map((option) => option.id)).toEqual(["high", "xhigh"]);
    expect(selection.selectedThinkingId).toBeNull();
  });

  it("restores the correct contract when switching back", () => {
    const switched = resolveAgentModelSelection({
      models: disjointModels,
      runtimeModelId: "model-b",
      configuredModelId: null,
      explicitThinkingOptionId: "xhigh",
    });
    expect(switched.selectedThinkingId).toBe("xhigh");

    const back = resolveAgentModelSelection({
      models: disjointModels,
      runtimeModelId: "model-a",
      configuredModelId: null,
      explicitThinkingOptionId: "xhigh",
    });
    expect(back.thinkingOptions?.map((option) => option.id)).toEqual(["low", "medium"]);
    expect(back.selectedThinkingId).toBeNull();
  });

  it("exposes no choices for a model without controllable reasoning", () => {
    const selection = resolveAgentModelSelection({
      models: disjointModels,
      runtimeModelId: "model-c",
      configuredModelId: null,
      explicitThinkingOptionId: "low",
    });

    expect(selection.thinkingOptions).toBeNull();
    expect(selection.selectedThinkingId).toBeNull();
  });
});

describe("parseRuntimeThinkingOption selector stability (V6)", () => {
  it("parses well-formed live thinking options", () => {
    expect(
      parseRuntimeThinkingOption([
        { id: "low", label: "Low", isDefault: true },
        { id: "medium", label: "Medium", description: "mid" },
      ]),
    ).toEqual([
      { id: "low", label: "Low", description: undefined, isDefault: true },
      { id: "medium", label: "Medium", description: "mid", isDefault: false },
    ]);
  });

  it("returns undefined for missing or unparseable payloads", () => {
    expect(parseRuntimeThinkingOption(undefined)).toBeUndefined();
    expect(parseRuntimeThinkingOption(null)).toBeUndefined();
    expect(parseRuntimeThinkingOption("low")).toBeUndefined();
    expect(parseRuntimeThinkingOption([])).toBeUndefined();
    expect(parseRuntimeThinkingOption([{ id: 7 }, null, "x"])).toBeUndefined();
  });

  it("returns a referentially stable result for equal content", () => {
    const first = parseRuntimeThinkingOption([
      { id: "high", label: "High" },
      { id: "xhigh", label: "XHigh", isDefault: true },
    ]);
    const second = parseRuntimeThinkingOption([
      { id: "high", label: "High" },
      { id: "xhigh", label: "XHigh", isDefault: true },
    ]);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("returns distinct results when content actually changes", () => {
    const before = parseRuntimeThinkingOption([{ id: "low", label: "Low" }]);
    const after = parseRuntimeThinkingOption([{ id: "medium", label: "Medium" }]);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});
