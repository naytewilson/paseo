import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { submitMessage } from "../support/helpers/composer";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

type V6DaemonClient = Pick<
  InternalDaemonClient,
  | "connect"
  | "close"
  | "patchDaemonConfig"
  | "refreshProvidersSnapshot"
  | "getProvidersSnapshot"
  | "setAgentModel"
  | "setAgentThinkingOption"
  | "fetchAgents"
>;

const FAKE_ACP = path.resolve("e2e/fixtures/v6-fake-acp.mjs");

test.describe("V6 model + reasoning fidelity (deterministic fake ACP)", () => {
  test("authoritative catalog, per-model choices, switching, stale invalidation, propagation, persistence, no silent fallback", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const shot = (name: string) => testInfo.outputPath(`${name}.png`);
    const fakeLog = testInfo.outputPath("prompt-boundary.jsonl");
    rmSync(fakeLog, { force: true });

    const configClient = await connectDaemonClient<V6DaemonClient>({
      clientIdPrefix: "app-e2e-v6",
    });
    try {
      // Point the copilot ACP provider at the deterministic fake.
      await configClient.patchDaemonConfig({
        providers: {
          copilot: {
            command: [process.execPath, FAKE_ACP],
            env: { V6_FAKE_LOG: fakeLog },
          },
        },
      } as never);
      const refreshed = await configClient.refreshProvidersSnapshot({
        providers: ["copilot" as never],
      });
      expect(refreshed, "providers snapshot refresh").toBeDefined();
      const snapshot = await configClient.getProvidersSnapshot();
      const copilot = (
        snapshot as {
          entries: Array<{ provider: string; status: string; models?: Array<{ id: string }> }>;
        }
      ).entries.find((entry) => entry.provider === "copilot");
      expect(copilot, "copilot snapshot entry").toBeDefined();
      expect(copilot!.status).toBe("ready");
      const modelIds = (copilot!.models ?? []).map((model) => model.id).sort();
      expect(modelIds).toEqual(["v6-model-a", "v6-model-b", "v6-model-c"]);

      // Seed workspace + copilot agent on model-a.
      const seeded = await seedWorkspace({ repoPrefix: "paseo-v6" });
      try {
        const agent = await seeded.client.createAgent({
          provider: "copilot",
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "v6-reasoning-check",
          model: "v6-model-a",
        });
        await openAgentRoute(page, { workspaceId: seeded.workspaceId, agentId: agent.id });
        await waitForSidebarHydration(page);
        await expect(page.getByTestId("combined-model-selector")).toBeVisible({ timeout: 30_000 });
        await page.screenshot({ path: shot("01-agent-open") });

        // Authoritative catalog render. On desktop the model browser opens in an
        // anchored combobox popover, not the compact model sheet.
        const openModelMenu = async () => {
          await page.getByTestId("combined-model-selector").click();
          const menu = page.getByTestId("combobox-desktop-container");
          await expect(menu).toBeVisible({ timeout: 10_000 });
          return menu;
        };
        const modelMenu = await openModelMenu();
        await expect(modelMenu.getByText("V6 Model A")).toBeVisible();
        await expect(modelMenu.getByText("V6 Model B")).toBeVisible();
        await expect(modelMenu.getByText("V6 Model C")).toBeVisible();
        await page.screenshot({ path: shot("02-catalog") });

        // Switch to model-b: only High/Extra high, default xhigh, stale low gone.
        // Display labels: xhigh renders as "Extra high" (formatThinkingOptionLabel).
        await modelMenu.getByText("V6 Model B").click();
        const thinking = page.getByTestId("agent-thinking-selector");
        await expect(thinking).toContainText("Extra high", { timeout: 15_000 });
        await thinking.click();
        const combo = page.getByTestId("combobox-desktop-container");
        await expect(combo).toBeVisible({ timeout: 10_000 });
        await expect(combo.getByText("High", { exact: true })).toBeVisible();
        await expect(combo.getByText("Extra high", { exact: true })).toBeVisible();
        await expect(combo.getByText("Low", { exact: true })).toHaveCount(0);
        await expect(combo.getByText("Medium", { exact: true })).toHaveCount(0);
        await page.screenshot({ path: shot("03-model-b-choices") });
        await combo.getByText("High", { exact: true }).click();
        await expect(thinking).toContainText("High", { timeout: 15_000 });

        // Switch back to model-a: Low/Medium restored, High/Extra high gone.
        const modelMenuA = await openModelMenu();
        await modelMenuA.getByText("V6 Model A").click();
        await expect(thinking).toContainText("Low", { timeout: 15_000 });
        await thinking.click();
        await expect(combo.getByText("Low", { exact: true })).toBeVisible();
        await expect(combo.getByText("Medium", { exact: true })).toBeVisible();
        await expect(combo.getByText("High", { exact: true })).toHaveCount(0);
        await expect(combo.getByText("Extra high", { exact: true })).toHaveCount(0);
        await page.screenshot({ path: shot("04-model-a-restored") });
        await combo.getByText("Medium", { exact: true }).click();
        await expect(thinking).toContainText("Medium", { timeout: 15_000 });

        // Model-c: no controllable reasoning -> no thinking control, no fake choices.
        const modelMenuC = await openModelMenu();
        await modelMenuC.getByText("V6 Model C").click();
        await expect(page.getByTestId("agent-thinking-selector")).toHaveCount(0, {
          timeout: 15_000,
        });
        await page.screenshot({ path: shot("05-model-c-no-thinking") });

        // No silent fallback: unsupported thinking on model-c must reject explicitly.
        let rejection: string | null = null;
        try {
          await configClient.setAgentThinkingOption(agent.id, "low");
        } catch (error) {
          rejection = error instanceof Error ? error.message : String(error);
        }
        expect(rejection, "unsupported thinking rejection").toMatch(
          /thought-level|not available|rejected/i,
        );
        const agentsAfterReject = await configClient.fetchAgents({ scope: "active" });
        const stillC = (
          agentsAfterReject as { entries: Array<{ agent: { id: string; model: string | null } }> }
        ).entries.find((entry) => entry.agent.id === agent.id);
        expect(stillC!.agent.model).toBe("v6-model-c");
        await page.screenshot({ path: shot("06-rejection-no-fallback") });

        // Propagation: model-a + medium reaches the provider boundary on a real turn.
        const modelMenuFinal = await openModelMenu();
        await modelMenuFinal.getByText("V6 Model A").click();
        await expect(thinking).toBeVisible({ timeout: 15_000 });
        await thinking.click();
        await combo.getByText("Medium", { exact: true }).click();
        await expect(thinking).toContainText("Medium", { timeout: 15_000 });
        await submitMessage(page, "v6 browser turn");
        await expect(page.getByText(/v6-fake-ok/)).toBeVisible({ timeout: 60_000 });
        await page.screenshot({ path: shot("07-turn-complete") });
        let boundary = "";
        for (let i = 0; i < 100 && !boundary; i++) {
          try {
            boundary = readFileSync(fakeLog, "utf8");
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        expect(boundary).toContain('"model":"v6-model-a"');
        expect(boundary).toContain('"thinking":"medium"');

        // Persistence across reload.
        await page.reload();
        await waitForSidebarHydration(page);
        await expect(page.getByTestId("combined-model-selector")).toContainText("V6 Model A", {
          timeout: 30_000,
        });
        await expect(page.getByTestId("agent-thinking-selector")).toContainText("Medium", {
          timeout: 15_000,
        });
        await page.screenshot({ path: shot("08-persisted-after-reload") });
      } finally {
        await seeded.cleanup();
      }
    } finally {
      await configClient.close();
    }
  });
});
