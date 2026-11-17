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
  "Generic draft detail commit path should trigger automatic card draft generation when suggested",
);
assert(
  /commitEditableCaptureDraft[\s\S]*maybeGenerateGardenCardAfterCommit/.test(libraryPageSource),
  "Editable paste/import commit path should trigger the same automatic draft generation helper",
);
assert(
  libraryPageSource.includes("已保存到资料库，并生成知识卡片草稿"),
  "Successful draft generation should be visible to the user with the confirmation step called out",
);
assert(
  libraryPageSource.includes("已保存，但知识卡片草稿生成失败"),
  "Draft generation failure should not rollback the committed note and should show a clear message",
);
assert(
  !libraryPageSource.includes("commitKnowledgeGardenDraft"),
  "Capture save flow must not commit a garden draft; the cards board owns confirmation",
);

[
  "正在生成 AI 建议...",
  "AI 建议生成失败，可手动填写或重试",
  "整理完成，可以保存",
  "正在保存草稿...",
  "正在写入资料库文件...",
  "正在重建索引和大纲...",
  "正在生成知识卡片草稿...",
  "未生成知识卡片草稿/已跳过",
  "知识卡片草稿生成失败",
  "保存完成",
  "保存后自动生成知识卡片草稿",
].forEach((label) => {
  assert(
    libraryPageSource.includes(label) || workbenchSource.includes(label),
    `Expected visible stage or UI label: ${label}`,
  );
});

console.log("knowledge capture card + feedback contract: ok");
