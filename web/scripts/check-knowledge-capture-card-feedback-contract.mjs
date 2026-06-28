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
  libraryPageSource.includes("已入库并生成知识卡片"),
  "Successful auto card generation should be visible to the user",
);
assert(
  libraryPageSource.includes("已入库，但知识卡片生成失败"),
  "Auto card generation failure should not rollback the committed note and should show a clear message",
);

[
  "正在整理正文...",
  "正在生成标题摘要标签...",
  "正在生成文件夹和卡片建议...",
  "整理完成，可以入库",
  "正在保存草稿...",
  "正在写入知识库文件...",
  "正在重建索引和大纲...",
  "正在生成知识卡片...",
  "入库完成",
  "入库后自动生成知识卡片",
].forEach((label) => {
  assert(
    libraryPageSource.includes(label) || workbenchSource.includes(label),
    `Expected visible stage or UI label: ${label}`,
  );
});

console.log("knowledge capture card + feedback contract: ok");
