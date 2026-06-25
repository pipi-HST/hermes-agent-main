import { chromium } from "playwright";

const baseUrl = process.env.HERMES_DASHBOARD_URL || "http://127.0.0.1:9119";

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });

try {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__HERMES_WS_URLS__ = [];
    window.__HERMES_WS_INSTANCES__ = [];
    window.WebSocket = class HermesRecordedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        window.__HERMES_WS_URLS__.push(String(url));
        super(url, protocols);
        window.__HERMES_WS_INSTANCES__.push(this);
      }
    };
  });

  await page.goto(`${baseUrl.replace(/\/$/, "")}/knowledge-chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => Array.isArray(window.__HERMES_WS_URLS__) && window.__HERMES_WS_URLS__.some((url) => url.includes("/api/ws?")),
    null,
    { timeout: 15_000 },
  );

  const wsUrl = await page.evaluate(() =>
    window.__HERMES_WS_URLS__.find((url) => url.includes("/api/ws?")),
  );
  assert(wsUrl, "Could not observe /api/ws WebSocket");

  await page.evaluate(
    () => {
      const ws = window.__HERMES_WS_INSTANCES__.find((candidate) =>
        String(candidate.url).includes("/api/ws?"),
      );
      if (!ws) {
        throw new Error("Could not find /api/ws instance");
      }
        const frames = [
          {
            method: "event",
            params: {
              type: "tool.start",
              session_id: "smoke",
              payload: { tool_id: "smoke-call-1", name: "research_with_web", context: "OpenAI 是什么" },
            },
          },
          {
            method: "event",
            params: {
              type: "tool.progress",
              session_id: "smoke",
              payload: {
                name: "research_with_web",
                preview: "规划检索任务",
                stage: "planning_start",
                status: "running",
              },
            },
          },
          {
            method: "event",
            params: {
              type: "tool.progress",
              session_id: "smoke",
              payload: {
                name: "research_with_web",
                preview: "搜索：OpenAI 是什么",
                stage: "web_query_start",
                status: "running",
              },
            },
          },
          {
            method: "event",
            params: {
              type: "tool.progress",
              session_id: "smoke",
              payload: {
                name: "research_with_web",
                preview: "证据裁判完成：采用 1，拒绝 0",
                stage: "evidence_critic_done",
                status: "completed",
              },
            },
          },
          {
            method: "event",
            params: {
              type: "tool.complete",
              session_id: "smoke",
              payload: { tool_id: "smoke-call-1", name: "research_with_web", summary: "检索过程完成" },
            },
          },
        ];
      frames.forEach((frame) => {
        ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      });
    },
  );

  await page.getByRole("button", { name: "详情" }).click();
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await page.getByText("检索过程").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText("规划检索任务").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText("搜索：OpenAI 是什么").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText("证据裁判完成：采用 1，拒绝 0").first().waitFor({ state: "visible", timeout: 10_000 });

  console.log("research progress live smoke: ok");
} finally {
  await browser.close();
}
