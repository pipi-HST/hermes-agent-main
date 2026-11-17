import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const libraryPagePath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url));
const workbenchPath = fileURLToPath(new URL("../src/pages/knowledge-chat/EditableCaptureWorkbench.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const libraryPageSource = readFileSync(libraryPagePath, "utf8");
const workbenchSource = readFileSync(workbenchPath, "utf8");

assert(
  libraryPageSource.includes("maybeGenerateGardenCardAfterCommit"),
  "KnowledgeLibraryPage should use one post-commit card helper for all capture draft commit paths",
);
assert(
  libraryPageSource.includes("bridgeMetaString(commitResult, \"capture_id\")") ||
    libraryPageSource.includes("bridgeMetaString(result, \"capture_id\")"),
  "Post-commit card helper should resolve capture id from commit response meta when available",
);
assert(
  libraryPageSource.includes("committed_capture_id"),
  "Post-commit card helper should fall back to draft detail committed_capture_id",
);
assert(
  /commitDraft[\s\S]*maybeGenerateGardenCardAfterCommit/.test(libraryPageSource),
  "Generic draft detail commit path should trigger automatic card generation when suggested",
);
assert(
  /commitEditableCaptureDraft[\s\S]*maybeGenerateGardenCardAfterCommit/.test(libraryPageSource),
  "Editable paste/import commit path should trigger the same automatic card generation helper",
);
assert(
  libraryPageSource.includes("已保存并生成知识卡片"),
  "Successful auto card generation should be visible to the user",
);
assert(
  libraryPageSource.includes("已保存，但知识卡片生成失败"),
  "Auto card generation failure should not rollback the committed note and should show a clear message",
);

[
  "正在生成 AI 建议...",
  "AI 建议生成失败，可手动填写或重试",
  "整理完成，可以保存",
  "正在保存草稿...",
  "正在写入知识库文件...",
  "正在重建索引和大纲...",
  "正在生成知识卡片...",
  "未生成知识卡片/已跳过",
  "知识卡片生成失败",
  "保存完成",
  "保存后自动生成知识卡片",
].forEach((label) => {
  assert(
    libraryPageSource.includes(label) || workbenchSource.includes(label),
    `Expected visible stage or UI label: ${label}`,
  );
});

console.log("knowledge capture card + feedback contract: ok");
