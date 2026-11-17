import { expect, test } from "playwright/test";

import {
  installKnowledgeBrowserFixture,
  type MockKnowledgeState,
} from "./knowledgeFixtures";

function assistantDraftMessage(id: string, label = "草稿编号") {
  return [
    { role: "user", text: "请把这篇文章保存" },
    { role: "assistant", text: `已生成待确认草稿。\n${label}：${id}` },
  ];
}

function captureState(id = "capture123456"): MockKnowledgeState {
  return {
    sessionId: "capture-history-e2e",
    messages: assistantDraftMessage(id),
    captureDrafts: [{
      id,
      title: "Capture 浏览器验收材料",
      status: "draft_ready",
      committed_capture_id: "",
      draft_text: "## 目录纲要\n\n- [正文](#正文)\n\n## 正文\n\n**Capture 内容**",
    }],
    readingDrafts: [],
  };
}

function readingState(id = "reading123456"): MockKnowledgeState {
  return {
    sessionId: "reading-history-e2e",
    messages: assistantDraftMessage(id),
    captureDrafts: [],
    readingDrafts: [{
      id,
      title: "Reading 浏览器验收材料",
      status: "open",
      target_capture_id: "",
      draft_text: "## 阅读结论\n\n**Reading 内容**",
    }],
  };
}

function assertCleanBrowser(probe: Awaited<ReturnType<typeof installKnowledgeBrowserFixture>>) {
  expect(probe.failedResponses).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
  expect(probe.unknownGatewayMethods).toEqual([]);
}

test("恢复 Capture 历史会话时只加载 Capture detail", async ({ page }) => {
  const state = captureState();
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);

  await expect(page.getByRole("heading", { name: "Capture 浏览器验收材料", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认保存" })).toBeVisible();
  expect(probe.requests).toContainEqual({ method: "GET", path: `/api/knowledge/capture-drafts/${state.captureDrafts[0].id}` });
  expect(probe.requests).not.toContainEqual({ method: "GET", path: `/api/knowledge/reading-drafts/${state.captureDrafts[0].id}` });
  assertCleanBrowser(probe);
});

test("恢复 Reading 历史会话时只加载 Reading detail", async ({ page }) => {
  const state = readingState();
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);

  await expect(page.getByRole("heading", { name: "Reading 浏览器验收材料" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认保存" })).toBeVisible();
  expect(probe.requests).toContainEqual({ method: "GET", path: `/api/knowledge/reading-drafts/${state.readingDrafts[0].id}` });
  expect(probe.requests).not.toContainEqual({ method: "GET", path: `/api/knowledge/capture-drafts/${state.readingDrafts[0].id}` });
  assertCleanBrowser(probe);
});

test("跨类型冲突的草稿编号不会触发 Reading 错误请求", async ({ page }) => {
  const sharedId = "shared123456";
  const state: MockKnowledgeState = {
    sessionId: "ambiguous-history-e2e",
    messages: assistantDraftMessage(sharedId),
    captureDrafts: [{
      ...captureState(sharedId).captureDrafts[0],
      id: sharedId,
    }],
    readingDrafts: [{
      ...readingState(sharedId).readingDrafts[0],
      id: sharedId,
    }],
  };
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);
  await expect(page.getByText(`草稿编号：${sharedId}`)).toBeVisible();

  await expect.poll(() => probe.requests).toContainEqual({
    method: "GET",
    path: `/api/knowledge/capture-drafts/${sharedId}`,
  });
  expect(probe.requests).not.toContainEqual({ method: "GET", path: `/api/knowledge/reading-drafts/${sharedId}` });
  assertCleanBrowser(probe);
});

test("不存在的草稿编号不会请求任何 detail 接口", async ({ page }) => {
  const missingId = "missing123456";
  const state: MockKnowledgeState = {
    sessionId: "missing-history-e2e",
    messages: assistantDraftMessage(missingId),
    captureDrafts: [],
    readingDrafts: [],
  };
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);
  await expect(page.getByText(`草稿编号：${missingId}`)).toBeVisible();

  expect(probe.requests.some(({ path }) => path.endsWith(`/${missingId}`))).toBe(false);
  assertCleanBrowser(probe);
});

test("Capture 待审草稿可以从历史会话确认保存", async ({ page }) => {
  const state = captureState("capturecommit1");
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);
  await page.getByRole("button", { name: "确认保存" }).click();

  await expect(page.getByText("这份材料已保存。需要调整内容时，请进入知识库编辑页。")).toBeVisible();
  expect(state.captureDrafts[0].status).toBe("committed");
  expect(probe.requests).toContainEqual({ method: "POST", path: `/api/knowledge/capture-drafts/${state.captureDrafts[0].id}/commit` });
  assertCleanBrowser(probe);
});

test("Reading 待审草稿可以从历史会话确认保存", async ({ page }) => {
  const state = readingState("readingcommit1");
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);
  await page.getByRole("button", { name: "确认保存" }).click();

  await expect(page.getByRole("button", { name: "确认保存" })).toHaveCount(0);
  expect(state.readingDrafts[0].status).toBe("committed");
  expect(probe.requests).toContainEqual({ method: "POST", path: `/api/knowledge/reading-drafts/${state.readingDrafts[0].id}/commit` });
  assertCleanBrowser(probe);
});

test("用户从输入框触发 Capture 工具后进入待审草稿", async ({ page }) => {
  const draft = captureState("gatewaycapture1").captureDrafts[0];
  const state: MockKnowledgeState = {
    sessionId: "gateway-capture-e2e",
    messages: [],
    captureDrafts: [],
    readingDrafts: [],
    promptScenario: {
      assistantText: `原文已提取，已生成待确认初稿。\n草稿编号：${draft.id}`,
      toolName: "capture_content",
      captureDraft: draft,
    },
  };
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);
  const composer = page.getByRole("textbox", { name: /直接问知识库/ });
  await composer.fill("请把这篇文章全文保存");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByRole("heading", { name: "Capture 浏览器验收材料", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认保存" })).toBeVisible();
  expect(probe.requests).toContainEqual({ method: "GET", path: `/api/knowledge/capture-drafts/${draft.id}` });
  expect(probe.requests).not.toContainEqual({ method: "GET", path: `/api/knowledge/reading-drafts/${draft.id}` });
  assertCleanBrowser(probe);
});

test("已保存文章在知识库展示目录并可跳转", async ({ page }) => {
  const itemId = "librarycapture1";
  const state: MockKnowledgeState = {
    sessionId: "library-e2e",
    messages: [],
    captureDrafts: [],
    readingDrafts: [],
    libraryItems: [{
      id: itemId,
      title: "知识库目录验收文章",
      body: [
        "## 目录纲要",
        "- [验证流程](#验证流程)",
        ...Array.from({ length: 60 }, (_, index) => `前置说明段落 ${index + 1}：用于验证目录点击后的真实滚动行为。`),
        "## 验证流程",
        "**目录跳转必须可用。**",
      ].join("\n\n"),
    }],
  };
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto("/knowledge-library");
  await expect.poll(() => probe.pageErrors).toEqual([]);
  await expect.poll(() => probe.consoleErrors).toEqual([]);
  await expect.poll(() => probe.requests).toContainEqual({
    method: "GET",
    path: "/api/knowledge/library/items",
  });
  await page.getByText("知识库目录验收文章", { exact: true }).first().click();
  const outlineLink = page.getByRole("link", { name: "验证流程" });
  const targetHeading = page.getByRole("heading", { name: "验证流程" });
  await expect(outlineLink).toBeVisible();
  await expect(targetHeading).not.toBeInViewport();
  await outlineLink.click();

  await expect(targetHeading).toBeInViewport();
  assertCleanBrowser(probe);
});

test("用户通过 Gateway 发起 RAG 后页面展示带引用答案", async ({ page }) => {
  const state: MockKnowledgeState = {
    sessionId: "gateway-rag-e2e",
    messages: [],
    captureDrafts: [],
    readingDrafts: [],
    promptScenario: {
      assistantText: "端到端验收必须检查真实持久化、索引检索和下游可见性。[1]",
      toolName: "research_with_web",
    },
  };
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);
  const composer = page.getByRole("textbox", { name: /直接问知识库/ });
  await composer.fill("知识库 Pipeline 应该怎样验收？");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("端到端验收必须检查真实持久化、索引检索和下游可见性。[1]", { exact: true })).toBeVisible();
  assertCleanBrowser(probe);
});

test("切换到仅知识库不会断开 Gateway", async ({ page }) => {
  const state: MockKnowledgeState = {
    sessionId: "gateway-mode-switch-e2e",
    messages: [],
    captureDrafts: [],
    readingDrafts: [],
  };
  const probe = await installKnowledgeBrowserFixture(page, state);

  await page.goto(`/knowledge-chat?session=${state.sessionId}`);
  await expect(page.getByText("已连接", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /联网搜索/ }).click();

  await expect(page.getByText("已连接", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/gateway not connected/)).toHaveCount(0);
  assertCleanBrowser(probe);
});
