import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const libraryPagePath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url));
const chatPagePath = fileURLToPath(new URL("../src/pages/KnowledgeChatPage.tsx", import.meta.url));
const workbenchPath = fileURLToPath(new URL("../src/pages/knowledge-chat/EditableCaptureWorkbench.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function functionBody(source, name) {
  const marker = `const ${name} = useCallback`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Expected ${name} callback`);
  const next = source.indexOf("\n  const ", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

function componentBody(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Expected ${name} component`);
  const next = source.indexOf("\nfunction ", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

const apiSource = readFileSync(apiPath, "utf8");
const librarySource = readFileSync(libraryPagePath, "utf8");
const chatSource = readFileSync(chatPagePath, "utf8");
const workbenchSource = readFileSync(workbenchPath, "utf8");

assert(apiSource.includes("organize?: boolean"), "Editable draft update request should expose organize?: boolean");

for (const [label, source] of [
  ["KnowledgeLibraryPage", librarySource],
  ["KnowledgeChatPage", chatSource],
]) {
  assert(source.includes("organizeEditableCaptureDraft"), `${label} should have an explicit AI organize path`);
  assert(source.includes("saveEditableCaptureDraftSnapshot"), `${label} should have a non-AI snapshot save path`);
  assert(source.includes("organize: true"), `${label} organize path should request organize: true`);
  assert(source.includes("organize: false"), `${label} snapshot path should request organize: false`);

  const commitBody = functionBody(source, "commitEditableCaptureDraft");
  assert(
    commitBody.includes("saveEditableCaptureDraftSnapshot"),
    `${label} commit should save the latest edits without AI organize`,
  );
  assert(
    !commitBody.includes("organizeEditableCaptureDraft") && !commitBody.includes("saveEditableCaptureDraft("),
    `${label} commit should not call the AI organize save path`,
  );
  assert(!commitBody.includes("正在整理正文"), `${label} commit progress should not mention body organizing`);
  assert(!commitBody.includes("正在生成标题摘要标签"), `${label} commit progress should not mention metadata generation`);
  assert(commitBody.includes("正在保存当前修改"), `${label} commit progress should start with saving current edits`);
}

const menuArea = librarySource.slice(librarySource.indexOf("newMenuOpen"), librarySource.indexOf("input", librarySource.indexOf("newMenuOpen")));
assert(menuArea.includes("新建知识文件"), "New menu should expose one unified knowledge-file entry");
assert(!menuArea.includes("粘贴整理"), "New menu should not expose a separate paste-organize entry");
assert(!menuArea.includes("新建空白文件"), "New menu should not expose a separate blank-file entry");

assert(workbenchSource.includes("生成 AI 建议"), "Editable workbench should label AI organization as generating AI suggestions");
assert(workbenchSource.includes("保存草稿"), "Editable workbench should support saving without AI organization");
assert(!workbenchSource.includes("整理成草稿"), "Editable workbench should not imply every save runs organization");

const fileWorkbench = componentBody(librarySource, "FileWorkbench");
assert(!fileWorkbench.includes("<StatusTile"), "FileWorkbench should not render the old status tile row");
assert(fileWorkbench.includes("元信息"), "FileWorkbench should expose metadata through a compact drawer or menu");
assert(fileWorkbench.includes("更多"), "FileWorkbench should group low-frequency actions under a more menu");

console.log("knowledge editor workflow contract: ok");
