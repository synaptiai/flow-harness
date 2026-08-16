import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { type Browser, chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import type { FlowPresentationDocument } from "../../src/domain/presentation/flow-presentation.js";
import { FLOW_PRESENTATION_API_VERSION } from "../../src/domain/presentation/flow-presentation.js";
import { LocalBrowserPresentationHost } from "../../src/infrastructure/http/local-browser-presentation-host.js";

describe("local browser presentation", () => {
  let browser: Browser | undefined;
  let host: LocalBrowserPresentationHost | undefined;

  afterEach(async () => {
    await browser?.close();
    await host?.close();
  });

  it("renders and steers one authenticated document without executing display text", async () => {
    const capability = Buffer.alloc(32, 0x55);
    const controller = new CaptureBrowserActions();
    host = new LocalBrowserPresentationHost({
      actionController: controller,
      createCapability: () => capability,
    });
    const session = await host.start();
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const consoleErrors: string[] = [];
    const requests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(session.url);
    await expect
      .poll(async () => await page.locator("#connection-status").textContent())
      .toBe("Connected");
    expect(new URL(page.url()).hash).toBe("");

    const presentation = completeDocument();
    await host.render(presentation);
    await expect
      .poll(async () => await page.locator("#run-title").textContent())
      .toBe("browser-workflow");
    await expect
      .poll(async () => await page.getByText("PRIVATE <img src=x onerror=alert(1)>").count())
      .toBe(1);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.getByRole("progressbar").getAttribute("max")).toBe("4");
    expect(await page.getByRole("table").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Approve exact request" }).count()).toBe(1);
    expect(await page.getByRole("main").count()).toBe(1);
    expect(await page.getByRole("complementary").count()).toBe(2);

    await page.reload();
    await expect
      .poll(async () => await page.locator("#connection-status").textContent())
      .toBe("Connected");
    await expect
      .poll(async () => await page.locator("#run-title").textContent())
      .toBe("browser-workflow");
    expect(new URL(page.url()).hash).toBe("");

    for (const viewport of [
      { name: "desktop", width: 1280, height: 720 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "mobile", width: 375, height: 812 },
    ] as const) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
        true,
      );
      const actionBox = await page
        .getByRole("button", { name: "Approve exact request" })
        .boundingBox();
      expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      const screenshotDirectory = process.env.FLOW_BROWSER_SCREENSHOT_DIR;
      if (screenshotDirectory !== undefined) {
        await mkdir(screenshotDirectory, { recursive: true });
        await page.screenshot({
          path: join(screenshotDirectory, `flow-browser-${viewport.name}.png`),
          fullPage: true,
        });
      }
    }

    await page.getByRole("button", { name: "Approve exact request" }).focus();
    expect(
      await page.getByRole("button", { name: "Approve exact request" }).evaluate((node) => {
        const style = node.ownerDocument.defaultView?.getComputedStyle(node);
        return (
          style !== undefined &&
          style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) > 0
        );
      }),
    ).toBe(true);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => controller.calls)
      .toEqual([{ documentSequence: 4, actionId: "approve:request-1", reason: undefined }]);
    await expect
      .poll(async () => await page.locator("#connection-status").textContent())
      .toBe("Action accepted");

    expect(consoleErrors).toEqual([]);
    expect(requests.every((url) => new URL(url).origin === new URL(session.url).origin)).toBe(true);
    expect(requests.map((url) => new URL(url).pathname)).toEqual(
      expect.arrayContaining(["/", "/app.css", "/app.js", "/api/documents", "/api/actions"]),
    );

    await page.close();
    const storageDeniedPage = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await storageDeniedPage.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("PRIVATE_STORAGE_DENIED", "SecurityError");
      };
      Storage.prototype.removeItem = () => {
        throw new DOMException("PRIVATE_STORAGE_DENIED", "SecurityError");
      };
    });
    await storageDeniedPage.goto(session.url);
    await expect
      .poll(async () => await storageDeniedPage.locator("#connection-status").textContent())
      .toBe("Connected");
    await expect
      .poll(async () => await storageDeniedPage.locator("#run-title").textContent())
      .toBe("browser-workflow");
    expect(new URL(storageDeniedPage.url()).hash).toBe("");

    await host.render({
      ...presentation,
      run: { ...presentation.run, status: "succeeded", sequence: 5 },
      actions: [],
    });
    await expect
      .poll(async () => await storageDeniedPage.locator("#connection-status").textContent())
      .toBe("Run observation ended");

    const unavailablePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await unavailablePage.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new DOMException("PRIVATE_STORAGE_DENIED", "SecurityError");
      };
    });
    await unavailablePage.goto(new URL(session.url).origin);
    await expect
      .poll(async () => await unavailablePage.locator("#connection-status").textContent())
      .toBe("Private session is unavailable");
  }, 20_000);
});

class CaptureBrowserActions {
  readonly calls: unknown[] = [];

  update(): void {}

  async executeCurrent(
    documentSequence: number,
    actionId: string,
    options: { readonly reason?: string } = {},
  ): Promise<void> {
    this.calls.push({ documentSequence, actionId, reason: options.reason });
  }
}

async function launchBrowser(): Promise<Browser> {
  return await chromium.launch(
    process.platform === "darwin" ? { channel: "chrome", headless: true } : { headless: true },
  );
}

function completeDocument(): FlowPresentationDocument {
  return {
    apiVersion: FLOW_PRESENTATION_API_VERSION,
    run: {
      runId: "browser-run",
      workflowId: "browser-workflow",
      status: "waiting_for_approval",
      sequence: 4,
    },
    layout: { density: "comfortable" },
    sections: [
      {
        id: "overview",
        title: "Run overview",
        components: [
          { kind: "heading", level: 2, text: "Execution flight strip" },
          { kind: "facts", items: [{ label: "Profile", value: "isolated" }] },
          { kind: "progress", label: "Graph progress", completed: 2, total: 4 },
          {
            kind: "table",
            columns: [{ key: "node", label: "Node" }],
            rows: [{ id: "row-1", cells: ["step"] }],
            truncated: false,
          },
          {
            kind: "notice",
            tone: "warning",
            text: "PRIVATE <img src=x onerror=alert(1)>",
          },
          { kind: "divider" },
        ],
      },
    ],
    actions: [
      {
        kind: "approve",
        actionId: "approve:request-1",
        requestId: "request-1",
        label: "Approve exact request",
      },
    ],
    truncated: false,
  };
}
