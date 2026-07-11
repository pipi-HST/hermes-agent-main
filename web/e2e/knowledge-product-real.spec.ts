import { expect, test } from "playwright/test";

const signal = process.env.HERMES_REAL_E2E_SIGNAL;
const title = process.env.HERMES_REAL_E2E_TITLE;

if (!signal || !title) {
  throw new Error("HERMES_REAL_E2E_SIGNAL and HERMES_REAL_E2E_TITLE are required");
}

test("真实浏览器提交的文章进入同一知识库并展示目录", async ({ page }) => {
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

  await page.getByPlaceholder("粘贴或写下要入库到知识库的内容").fill(content);
  await page.getByPlaceholder("可选，不填则 Hermes 自动生成").fill(title);
  await page.getByRole("button", { name: "生成 AI 建议" }).click();
  await expect(page.getByText("整理完成，可以入库", { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  await page.getByRole("button", { name: "入库到知识库" }).click();
  await expect(page.getByText("入库完成", { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  await page.getByRole("button", { name: /所有文件/ }).click();
  await page.getByPlaceholder("搜索文件").fill(title);
  const libraryItem = page.getByRole("button").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  }).first();
  await expect(libraryItem).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/library/items/capture/") && response.status() === 200,
      { timeout: 30_000 },
    ),
    libraryItem.click(),
  ]);

  await expect(page.getByText(signal, { exact: false })).toBeVisible({ timeout: 30_000 });
  const outlineLink = page.locator('a[href^="#"]').first();
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
});
