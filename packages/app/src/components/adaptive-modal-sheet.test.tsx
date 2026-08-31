/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const useBottomSheetInternal = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("useBottomSheetInternal called outside BottomSheet context");
  }),
);

const sheetHeader = { title: "Select model" };
const handleClose = vi.fn();

const theme = vi.hoisted(() => ({
  spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
  fontSize: { base: 16 },
  fontWeight: { medium: "500" },
  borderRadius: { lg: 8, xl: 12, "2xl": 16 },
  iconSize: { sm: 16, md: 20 },
  colors: {
    foreground: "#fff",
    foregroundMuted: "#aaa",
    surface0: "#000",
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    palette: { zinc: { 600: "#52525b" } },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (value: typeof theme) => unknown)(theme)
        : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetBackdrop: () => null,
  BottomSheetScrollView: ({ children }: { children?: ReactNode }) => children ?? null,
  KEYBOARD_STATUS: { SHOWN: "SHOWN" },
  useBottomSheetInternal,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
  useAnimatedStyle: (factory: () => unknown) => factory(),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => true,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: false,
}));

vi.mock("@/hooks/use-keyboard-visibility", () => ({
  useKeyboardVisibility: () => false,
}));

vi.mock("@/components/adaptive-text-input", () => ({
  AdaptiveTextInput: () => null,
}));

vi.mock("../lib/overlay-root", () => ({
  getOverlayRoot: () => document.body,
  OverlayLayerProvider: ({ children }: { children?: ReactNode }) => children ?? null,
  useGlobalWebOverlayLayer: () => 1,
  useWebOverlayRegistration: () => undefined,
}));

vi.mock("@/components/ui/isolated-bottom-sheet-modal", () => ({
  IsolatedBottomSheetModal: ({ children }: { children?: ReactNode }) => children ?? null,
  useIsolatedBottomSheetVisibility: () => ({
    sheetRef: () => undefined,
    handleSheetChange: () => undefined,
    handleSheetDismiss: () => undefined,
  }),
}));

import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";

describe("AdaptiveModalSheet compact current-snap sizing", () => {
  it("renders the dropdown without reaching through Gorhom's private BottomSheet context", () => {
    render(
      <AdaptiveModalSheet
        header={sheetHeader}
        visible
        onClose={handleClose}
        scrollable={false}
        sizeContentToCurrentSnapPoint
      >
        <span>Gemini Flash</span>
      </AdaptiveModalSheet>,
    );

    expect(screen.getByText("Gemini Flash")).toBeTruthy();
    expect(useBottomSheetInternal).not.toHaveBeenCalled();
  });
});
