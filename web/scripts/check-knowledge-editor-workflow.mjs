import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const libraryPagePath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url));
const libraryHeaderPath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryHeader.tsx", import.meta.url));
const libraryHelpersPath = fileURLToPath(new URL("../src/pages/knowledge-library/helpers.ts", import.meta.url));
const fileWorkbenchPath = fileURLToPath(new URL("../src/pages/knowledge-library/FileWorkbench.tsx", import.meta.url));
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
const libraryHeaderSource = readFileSync(libraryHeaderPath, "utf8");
const librarySource = readFileSync(libraryPagePath, "utf8")
  + "\n" + libraryHeaderSource
  + "\n" + readFileSync(libraryHelpersPath, "utf8")
  + "\n" + readFileSync(fileWorkbenchPath, "utf8");
const chatSource = readFileSync(chatPagePath, "utf8");
const workbenchSource = readFileSync(workbenchPath, "utf8");

assert(apiSource.includes("organize?: boolean"), "Editable draft update request should expose organize?: boolean");
assert(apiSource.includes("title_source?: \"ai\" | \"user\""), "Editable draft requests should expose title_source ownership");
assert(
  apiSource.includes("function requireKnowledgeBusinessSuccess"),
  "Knowledge commit API should define a business-response success guard",
);
const knowledgeCommitApi = apiSource.slice(
  apiSource.indexOf("commitKnowledgeCaptureDraft:"),
  apiSource.indexOf("reviseKnowledgeCaptureDraft:"),
);
assert(
  knowledgeCommitApi.includes("requireKnowledgeBusinessSuccess"),
  "Knowledge commit API should reject HTTP 200 business errors before pages report success",
);
for (const marker of ["result.ok === false", "result.status === \"error\"", "result.error", "result.errors"]) {
  assert(apiSource.includes(marker), `Knowledge business-response guard should check ${marker}`);
}
assert(
  chatSource.includes("function isCommittedCaptureDraft"),
  "Knowledge chat should classify drafts with a committed Capture pointer as already in library",
);
assert(
  chatSource.includes('draftFilter === "committed" && !isCommittedCaptureDraft(draft)'),
  "Knowledge chat committed filter should use the committed Capture compatibility contract",
);

for (const [label, source] of [
  ["KnowledgeLibraryPage", librarySource],
  ["KnowledgeChatPage", chatSource],
]) {
  assert(source.includes("organizeEditableCaptureDraft"), `${label} should have an explicit AI organize path`);
  assert(source.includes("saveEditableCaptureDraftSnapshot"), `${label} should have a non-AI snapshot save path`);
  assert(
    source.includes("regenerateKnowledgeEditableCaptureDraft"),
    `${label} should regenerate existing draft suggestions through the dedicated workspace call`,
  );
  assert(source.includes("organize: true"), `${label} create path should request organize: true`);
  assert(source.includes("organize: false"), `${label} snapshot path should request organize: false`);
  assert(source.includes("editableTitleSource"), `${label} should track whether the title is AI-owned or user-owned`);
  assert(source.includes("title_source: editableTitleSource"), `${label} should pass title_source to editable draft APIs`);
  assert(source.includes("setEditableTitleSource(\"user\")"), `${label} should mark manually edited titles as user-owned`);
  assert(source.includes("editableDraftTitleSource(draft)"), `${label} should derive title ownership from the loaded draft`);
  assert(source.includes("isGenericEditableTitle"), `${label} should not preserve generic placeholder titles as user-owned`);

  const organizeBody = functionBody(source, "organizeEditableCaptureDraft");
  assert(
    organizeBody.includes("regenerateKnowledgeEditableCaptureDraft"),
    `${label} regenerate action should call the dedicated editable suggestion workflow`,
  );
  assert(
    !organizeBody.includes("updateKnowledgeEditableCaptureDraft"),
    `${label} regenerate action should not use the generic editable draft PATCH`,
  );

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

  const workbenchStart = source.indexOf("<EditableCaptureWorkbench");
  const workbenchEnd = source.indexOf("/>", workbenchStart);
  const workbenchCall = source.slice(workbenchStart, workbenchEnd >= 0 ? workbenchEnd : source.length);
  assert(
    workbenchCall.includes("onOrganizeDraft={() => void organizeEditableCaptureDraft()}"),
    `${label} workbench should expose the single AI suggestion action`,
  );
  assert(
    !workbenchCall.includes("onSaveDraft"),
    `${label} workbench should not wire a duplicate save-and-organize action`,
  );
}

const menuArea = libraryHeaderSource.slice(libraryHeaderSource.indexOf("newMenuOpen"), libraryHeaderSource.indexOf("input", libraryHeaderSource.indexOf("newMenuOpen")));
assert(menuArea.includes("新建知识文件"), "New menu should expose one unified knowledge-file entry");
assert(!menuArea.includes("粘贴整理"), "New menu should not expose a separate paste-organize entry");
assert(!menuArea.includes("新建空白文件"), "New menu should not expose a separate blank-file entry");

assert(workbenchSource.includes("生成 AI 建议"), "Editable workbench should label AI organization as generating AI suggestions");
assert(!workbenchSource.includes("保存草稿并生成 AI 建议"), "Editable workbench should not render a duplicate save-and-organize button");
assert(workbenchSource.includes("ai_suggestions_status"), "Editable workbench should read AI suggestion completion status");
assert(workbenchSource.includes("正在生成 AI 建议..."), "Editable workbench should show one real AI suggestion running state");
assert(!workbenchSource.includes("正在生成标题摘要标签"), "Editable workbench should not show fake metadata sub-stages");
assert(!workbenchSource.includes("正在生成文件夹和卡片建议"), "Editable workbench should not show fake suggestion sub-stages");
assert(
  workbenchSource.includes("if (aiGenerated || committing || committed)") &&
    workbenchSource.includes('steps.push({ label: "整理完成，可以保存"'),
  "Editable workbench should only show ready-to-commit status after AI suggestions are generated",
);
assert(!workbenchSource.includes("整理成草稿"), "Editable workbench should not imply every save runs organization");

const fileWorkbench = componentBody(librarySource, "FileWorkbench");
assert(!fileWorkbench.includes("<StatusTile"), "FileWorkbench should not render the old status tile row");
assert(!fileWorkbench.includes("元信息"), "FileWorkbench should not expose an engineering metadata drawer");
assert(fileWorkbench.includes("提炼卡片"), "FileWorkbench should surface card extraction on the main reading toolbar");
assert(fileWorkbench.includes("更多"), "FileWorkbench should group low-frequency actions under a more menu");
assert(
  librarySource.includes("没有活跃知识卡片、待提交卡片草稿和其他文件引用"),
  "Permanent delete confirmation should describe only active blocking dependencies",
);

console.log("knowledge editor workflow contract: ok");
