import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("PASEO Browser CLI Fidelity Presentation V5", () => {
  test("renders real browser tool card with Read and file path summary", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ toolCallDetailLevel: "overview" }),
      );
    });

    const agent = await seedMockAgentWorkspace({
      repoPrefix: "tool-call-overview-sheet-",
      title: "Desktop overview tool calls",
      model: "ten-second-stream",
    });

    try {
      await openAgentRoute(page, {
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
      });
      await expectComposerVisible(page);
      await agent.client.sendAgentMessage(agent.agentId, "Exercise desktop overview tool calls.");

      const group = page.getByTestId("tool-call-group").first();
      await expect(group).toBeVisible({ timeout: 20_000 });
      await group.click();

      // Verify the real rendered tool-call card
      const readBadge = group.getByTestId("tool-call-badge").first();
      await expect(readBadge).toBeVisible({ timeout: 20_000 });
      await expect(readBadge).toContainText("Read");
      await expect(readBadge).toContainText("packages/app/src/components/conversation-list.tsx");
      await expect(readBadge).not.toHaveText(/read_file/);

      // Verify single card per lifecycle (not duplicated)
      const allReadBadges = group.getByTestId("tool-call-badge").filter({ hasText: "packages/app/src/components/conversation-list.tsx" });
      await expect(allReadBadges).toHaveCount(1);

      // Capture screenshot artifact
      const screenshotPath = testInfo.outputPath("paseo-browser-cli-fidelity-cards-v5.png");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach("paseo-browser-cli-fidelity-cards-v5", {
        path: screenshotPath,
        contentType: "image/png",
      });
    } finally {
      await agent.cleanup();
    }
  });
});
