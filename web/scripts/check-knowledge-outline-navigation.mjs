import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const markdownNavigationPath = fileURLToPath(
  new URL("../src/lib/markdownNavigation.ts", import.meta.url),
);
const toolElapsedPath = fileURLToPath(
  new URL("../src/lib/toolElapsed.ts", import.meta.url),
);
const markdownPath = fileURLToPath(
  new URL("../src/components/Markdown.tsx", import.meta.url),
);
const toolCallPath = fileURLToPath(
  new URL("../src/components/ToolCall.tsx", import.meta.url),
);
const libraryPagePath = fileURLToPath(
  new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url),
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadTsModule(path) {
  assert(existsSync(path), `${path} does not exist`);
  const source = readFileSync(path, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (id) => {
      throw new Error(`Unexpected import while checking knowledge outline contract: ${id}`);
    },
    URL,
    console,
  });
  return module.exports;
}

const {
  analyzeKnowledgeOutlineMarkdown,
  buildHeadingAnchors,
  linkKnowledgeOutlineMarkdown,
  markdownHeadingId,
  repairKnowledgeOutlineMarkdown,
} = loadTsModule(markdownNavigationPath);
const { elapsedMsForTool } = loadTsModule(toolElapsedPath);

const runningTool = {
  status: "running",
  startedAt: 1_000,
};
assert(
  elapsedMsForTool(runningTool, 6_500) === 5_500,
  "Collapsed running tools should compute elapsed from the current clock",
);

const doneTool = {
  status: "done",
  startedAt: 1_000,
  completedAt: 4_000,
};
assert(
  elapsedMsForTool(doneTool, 99_000) === 3_000,
  "Completed tools should use completedAt instead of the current clock",
);

assert(
  markdownHeadingId("三、吴越国钱氏世系") === "三-吴越国钱氏世系",
  "Chinese headings should get deterministic readable ids",
);

const anchors = buildHeadingAnchors([
  { level: 3, content: "一、历史背景：从唐末崩解到五代十国的乱世" },
  { level: 3, content: "一、历史背景：从唐末崩解到五代十国的乱世" },
  { level: 3, content: "三、吴越国钱氏世系" },
]);
assert(
  anchors[0].id === "一-历史背景-从唐末崩解到五代十国的乱世",
  "First duplicate heading should keep its base id",
);
assert(
  anchors[1].id === "一-历史背景-从唐末崩解到五代十国的乱世-2",
  "Duplicate headings should receive a numeric suffix",
);
assert(
  anchors[2].id === "三-吴越国钱氏世系",
  "Later headings should keep deterministic ids",
);

const outlineMarkdown = [
  "## 目录纲要",
  "",
  "- 历史背景：从唐末崩解到五代十国的乱世：概述公元907年朱温篡唐。",
  "  - 吴越国钱氏世系：分述吴越国钱元瓘等。",
  "- 不存在的章节：保持普通文本。",
  "",
  "### 一、历史背景：从唐末崩解到五代十国的乱世",
  "",
  "正文。",
  "",
  "### 三、吴越国钱氏世系",
  "",
  "正文。",
].join("\n");
const linked = linkKnowledgeOutlineMarkdown(outlineMarkdown);
assert(
  linked.includes(
    "- [历史背景：从唐末崩解到五代十国的乱世：概述公元907年朱温篡唐。](#一-历史背景-从唐末崩解到五代十国的乱世)",
  ),
  "Outline items should link to matching later headings",
);
assert(
  linked.includes(
    "  - [吴越国钱氏世系：分述吴越国钱元瓘等。](#三-吴越国钱氏世系)",
  ),
  "Indented outline items should link to matching later headings",
);
assert(
  linked.includes("- 不存在的章节：保持普通文本。"),
  "Unmatched outline items should remain plain text",
);

const partialOutlineMarkdown = [
  "## 目录纲要",
  "",
  "- 引言：先说为什么文科生也能 vibecoding。",
  "- 经验一：命令清晰且聚焦：写清楚目标和边界。",
  "- 经验二：学会用Git：每一步都能回退。",
  "- 经验七：不要迷信模型能力，掌握决策主动权：人要保留取舍。",
  "- 不存在的章节：保持普通文本。",
  "",
  "## 引言",
  "",
  "正文。",
  "",
  "命令清晰且聚焦，意思是每次只让 AI 做一件具体的事。",
  "",
  "学会使用 Git，至少要知道如何提交和回退。",
  "",
  "不要迷信模型能力，掌握决策的主动权。",
].join("\n");
const analysis = analyzeKnowledgeOutlineMarkdown(partialOutlineMarkdown);
assert(
  analysis.missing.some((issue) => issue.title === "经验一：命令清晰且聚焦"),
  "Outline analysis should detect missing heading targets for experience items",
);
const repairedOutlineMarkdown = repairKnowledgeOutlineMarkdown(partialOutlineMarkdown);
assert(
  repairedOutlineMarkdown.includes("## 经验一：命令清晰且聚焦"),
  "Outline repair should insert a heading before matching body text",
);
assert(
  repairedOutlineMarkdown.includes("## 经验二：学会用Git"),
  "Outline repair should insert headings for multiple missing outline targets",
);
assert(
  repairedOutlineMarkdown.includes("## 经验七：不要迷信模型能力，掌握决策主动权"),
  "Outline repair should tolerate small wording differences in section titles",
);
const repairedAnalysis = analyzeKnowledgeOutlineMarkdown(repairedOutlineMarkdown);
assert(
  repairedAnalysis.missing.some((issue) => issue.title === "不存在的章节"),
  "Unmatched outline items should remain reported instead of linking to the wrong section",
);
assert(
  !repairedAnalysis.missing.some((issue) => issue.title === "经验一：命令清晰且聚焦"),
  "Repaired experience headings should become valid outline targets",
);
const repairedLinked = linkKnowledgeOutlineMarkdown(repairedOutlineMarkdown);
assert(
  repairedLinked.includes(
    "- [经验一：命令清晰且聚焦：写清楚目标和边界。](#经验一-命令清晰且聚焦)",
  ),
  "Repaired outline items should link to inserted headings",
);

const markdownSource = readFileSync(markdownPath, "utf8");
assert(
  markdownSource.includes("buildHeadingAnchors"),
  "Markdown renderer should use stable heading anchors",
);
assert(
  markdownSource.includes("href.startsWith(\"#\")"),
  "Markdown renderer should handle local anchor links without opening a new tab",
);

const toolCallSource = readFileSync(toolCallPath, "utf8");
assert(
  toolCallSource.includes("elapsedMsForTool"),
  "ToolCall should use shared elapsed calculation",
);
assert(
  !toolCallSource.includes('tool.status !== "running" || !open'),
  "ToolCall ticker must not depend on the row being expanded",
);
assert(
  toolCallSource.includes("visibilitychange"),
  "ToolCall should refresh elapsed time when the page becomes visible again",
);

const libraryPageSource = readFileSync(libraryPagePath, "utf8");
assert(
  libraryPageSource.includes("enableKnowledgeOutlineLinks"),
  "Knowledge library article view should enable outline links",
);
assert(
  libraryPageSource.includes("analyzeKnowledgeOutlineMarkdown"),
  "Knowledge library edit save should analyze outline link coverage before saving",
);
assert(
  libraryPageSource.includes("repairKnowledgeOutlineMarkdown"),
  "Knowledge library edit save should offer deterministic outline repair before saving",
);
assert(
  libraryPageSource.includes('searchParams.get("kind")')
    && libraryPageSource.includes('searchParams.get("item")')
    && libraryPageSource.includes('requestedMode === "edit"'),
  "Knowledge library should support kind + item + mode=edit deep links",
);
assert(
  libraryPageSource.includes("目标文件已不存在或已被删除。"),
  "Missing deep-linked library items should show a non-error notice",
);

console.log(`knowledge outline navigation contract passed in ${webRoot}`);
