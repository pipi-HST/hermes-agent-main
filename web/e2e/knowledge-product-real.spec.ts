import { expect, test } from "playwright/test";

const signal = process.env.HERMES_REAL_E2E_SIGNAL;
const title = process.env.HERMES_REAL_E2E_TITLE;

if (!signal || !title) {
  throw new Error("HERMES_REAL_E2E_SIGNAL and HERMES_REAL_E2E_TITLE are required");
}

test("真实浏览器提交的文章可展示目录并被纯知识库 RAG 引用", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  const content = [
    `# ${title}`,
    "",
    signal,
    "",
    "## 验收背景",
    "",
    "这篇材料由真实 Chromium 页面创建，用于验证浏览器、Runtime、Custom API、SQLite、Markdown 和索引使用同一份数据。",
    "",
    ...Array.from(
      { length: 45 },
      (_, index) => `验证段落 ${index + 1}：端到端测试必须检查最终产物和下游可见性，不能只检查接口返回成功。`,
    ),
    "",
    "## 验收步骤",
    "",
    "1. 从页面创建草稿。",
    "2. 点击入库。",
    "3. 在知识库重新打开文章。",
    "4. 验证目录、索引和检索。",
  ].join("\n\n");

  await page.goto("/knowledge-library");
  await page.getByRole("button", { name: "新建" }).click();
  await page.getByText("新建知识文件", { exact: true }).last().click();

  const editor = page.getByPlaceholder("粘贴或写下要入库到知识库的内容");
  await editor.fill(content);
  await page.getByPlaceholder("可选，不填则 Hermes 自动生成").fill(title);
  await page.getByRole("button", { name: "生成 AI 建议" }).click();
  await expect(page.getByText("整理完成，可以入库", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  const organizedContent = await editor.inputValue();
  if (!organizedContent.includes(signal)) {
    await editor.fill(`${organizedContent}\n\n**${signal}**`);
  }

  await page.getByRole("button", { name: "入库到知识库" }).click();
  await expect(page.getByText("入库完成", { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  await page.getByPlaceholder("搜索文件").fill(title);
  const libraryItem = page.getByRole("button").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  }).first();
  await expect(libraryItem).toBeVisible();
  await libraryItem.click();

  const article = page.locator("[data-markdown-root]").filter({ hasText: signal }).first();
  await expect(article).toBeVisible({ timeout: 30_000 });
  const outlineLink = article.locator('a[href^="#"]').first();
  await expect(outlineLink).toBeVisible({ timeout: 30_000 });
  const targetHash = await outlineLink.getAttribute("href");
  expect(targetHash).toMatch(/^#.+/);
  await outlineLink.click();
  const targetId = decodeURIComponent(targetHash!.slice(1));
  await expect.poll(() => page.evaluate((id) => {
    const target = document.getElementById(id);
    if (!target || !/^H[1-6]$/.test(target.tagName)) return false;
    const rect = target.getBoundingClientRect();
    return rect.top >= 0 && rect.top <= window.innerHeight;
  }, targetId)).toBe(true);

  await page.getByRole("link", { name: "专题输出" }).click();
  await expect(page.getByText("已连接", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const webToggle = page.getByRole("button", { name: /联网搜索/ });
  await expect(webToggle).toHaveAttribute("aria-pressed", "true");
  await webToggle.click();
  await expect(webToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("📚 默认检索个人知识库（卡片 + 资料）")).toBeVisible();
  await expect(page.getByText(/gateway not connected/)).toHaveCount(0);

  const composer = page.getByRole("textbox", { name: /直接问知识库/ });
  await composer.fill(`只使用知识库回答：${signal} 这篇文章强调了什么？请引用《${title}》。`);
  await page.getByRole("button", { name: "发送" }).click();

  const sourceSummary = page.getByText(/(?:引用|使用)来源 \d+/, { exact: true }).last();
  await expect(sourceSummary).toBeVisible({ timeout: 120_000 });
  await sourceSummary.click();
  const sourceDetails = sourceSummary.locator("xpath=..");
  await expect(sourceDetails.getByText("📚 个人知识库（卡片与资料）", { exact: true })).toBeVisible();
  await expect(sourceDetails.getByText("🌐 DeepSeek 联网来源", { exact: true })).toHaveCount(0);
  const knowledgeSource = sourceDetails.getByRole("button", {
    name: new RegExp(title),
  }).first();
  await expect(knowledgeSource).toBeVisible();
  await knowledgeSource.click();

  await expect(page).toHaveURL(/\/knowledge-library$/);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
});
