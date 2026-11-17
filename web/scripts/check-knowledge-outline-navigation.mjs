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
const readingOverlayPath = fileURLToPath(
  new URL("../src/pages/knowledge-library/ReadingOverlay.tsx", import.meta.url),
);
const draftReviewPath = fileURLToPath(
  new URL("../src/pages/knowledge-chat/DraftReview.tsx", import.meta.url),
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertOutlineLinksResolve(markdown, message) {
  const lines = markdown.split("\n");
  const headingMatches = [];
  let outlineStart = -1;
  let outlineEnd = lines.length;
  for (const [lineIndex, line] of lines.entries()) {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    if (match[2].trim() === "目录纲要") {
      outlineStart = lineIndex;
      continue;
    }
    headingMatches.push({
      level: match[1].length,
      content: match[2].trim(),
      lineIndex,
    });
    if (outlineStart >= 0 && outlineEnd === lines.length && lineIndex > outlineStart) {
      outlineEnd = lineIndex;
    }
  }
  assert(outlineStart >= 0, `${message}: outline heading missing`);
  const ids = new Set(buildHeadingAnchors(headingMatches).map((heading) => heading.id));
  for (let index = outlineStart + 1; index < outlineEnd; index++) {
    const link = /\[[^\]]+\]\(#([^)]+)\)/.exec(lines[index]);
    if (!link) continue;
    assert(ids.has(link[1]), `${message}: missing heading target #${link[1]}`);
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
    "- [历史背景：从唐末崩解到五代十国的乱世](#一-历史背景-从唐末崩解到五代十国的乱世)：概述公元907年朱温篡唐。",
  ),
  "Outline items should link to matching later headings",
);
assert(
  linked.includes(
    "  - [吴越国钱氏世系](#三-吴越国钱氏世系)：分述吴越国钱元瓘等。",
  ),
  "Indented outline items should link to matching later headings",
);
assert(
  linked.includes("- 不存在的章节：保持普通文本。"),
  "Unmatched outline items should remain plain text",
);
assertOutlineLinksResolve(linked, "Legacy outline links");

const agentHarnessOutlineMarkdown = [
  "## 目录纲要",
  "",
  "- 三层工程：描述模型周围的三层工程：提示词工程、上下文工程和Harness工程。",
  "",
  "## 三层工程",
  "",
  "正文。",
].join("\n");
const agentHarnessLinked = linkKnowledgeOutlineMarkdown(agentHarnessOutlineMarkdown);
assert(
  agentHarnessLinked.includes(
    "- [三层工程](#三层工程)：描述模型周围的三层工程：提示词工程、上下文工程和Harness工程。",
  ),
  "Multi-colon outline summaries should link only the short title before the first colon",
);
assertOutlineLinksResolve(agentHarnessLinked, "Agent Harness outline links");

const codeFenceOutlineMarkdown = [
  "## 目录纲要",
  "",
  "- 代码里的标题：不应该链接到代码块。",
  "- 正文标题：应该链接到正文 heading。",
  "",
  "```md",
  "## 代码里的标题",
  "```",
  "",
  "## 正文标题",
  "",
  "正文。",
].join("\n");
const codeFenceLinked = linkKnowledgeOutlineMarkdown(codeFenceOutlineMarkdown);
assert(
  codeFenceLinked.includes("- 代码里的标题：不应该链接到代码块。"),
  "Outline linking should ignore headings inside fenced code blocks",
);
assert(
  codeFenceLinked.includes("- [正文标题](#正文标题)：应该链接到正文 heading。"),
  "Outline linking should still use real headings after fenced code blocks",
);
assertOutlineLinksResolve(codeFenceLinked, "Code fence outline links");

const currentAffairsOutlineMarkdown = [
  "## 目录纲要",
  "",
  "- G7峰会叙事与本文立场：G7峰会认为乌克兰能翻盘，俄罗斯撑不住，但作者认为此叙事站不住脚。",
  "- “高利率+高通胀”的现实与现实原因：通过经济数据分析，指出俄乌及欧美均出现高利率与高通胀并行。",
  "",
  "## G7峰会叙事与本文立场",
  "",
  "正文。",
  "",
  "## 高利率与高通胀并行的现实与原因",
  "",
  "正文。",
].join("\n");
const currentAffairsLinked = linkKnowledgeOutlineMarkdown(currentAffairsOutlineMarkdown);
assert(
  currentAffairsLinked.includes(
    "- [G7峰会叙事与本文立场](#G7峰会叙事与本文立场)：G7峰会认为乌克兰能翻盘，俄罗斯撑不住，但作者认为此叙事站不住脚。",
  ),
  "Screenshot-style outline items should link when the title before the colon matches a later heading",
);
assert(
  currentAffairsLinked.includes(
    "- “高利率+高通胀”的现实与现实原因：通过经济数据分析，指出俄乌及欧美均出现高利率与高通胀并行。",
  ),
  "Similar but non-identical outline items should remain plain text instead of fake-linking",
);

const partialOutlineMarkdown = [
  "## 目录纲要",
  "",
  "- 引言：先说为什么文科生也能 vibecoding。",
  "- 经验一：命令清晰且聚焦：写清楚目标和边界。",
  "- 经验二：学会用 Git：每一步都能回退。",
  "- 经验七：不要迷信模型能力，掌握决策主动权：人要保留取舍。",
  "- 不存在的章节：保持普通文本。",
  "",
  "## 引言",
  "",
  "正文。",
  "",
  "经验一：命令清晰且聚焦，意思是每次只让 AI 做一件具体的事。",
  "",
  "经验二：学会用 Git，至少要知道如何提交和回退。",
  "",
  "经验七：不要迷信模型能力，掌握决策主动权。",
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
  repairedOutlineMarkdown.includes("## 经验二：学会用 Git"),
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
    "- [经验一：命令清晰且聚焦](#经验一-命令清晰且聚焦)：写清楚目标和边界。",
  ),
  "Repaired outline items should link to inserted headings",
);
assertOutlineLinksResolve(repairedLinked, "Repaired outline links");

const markdownSource = readFileSync(markdownPath, "utf8");
assert(
  markdownSource.includes("buildHeadingAnchors"),
  "Markdown renderer should use stable heading anchors",
);
assert(
  markdownSource.includes("data-markdown-root") && markdownSource.includes("closest(\"[data-markdown-root]\")"),
  "Markdown local anchor clicks should resolve targets inside the current markdown root",
);
assert(
  markdownSource.includes("href.startsWith(\"#\")"),
  "Markdown renderer should handle local anchor links without opening a new tab",
);
assert(
  markdownSource.includes("normalizeCopiedKnowledgeOutlineLinks")
    && markdownSource.includes("127\\.0\\.0\\.1")
    && markdownSource.includes("localhost"),
  "Markdown copy handling should normalize local absolute outline URLs back to relative anchors",
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
const readingOverlaySource = readFileSync(readingOverlayPath, "utf8");
const libraryOutlineSource = `${libraryPageSource}\n${readingOverlaySource}`;
assert(
  libraryOutlineSource.includes("enableKnowledgeOutlineLinks"),
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

const draftReviewSource = readFileSync(draftReviewPath, "utf8");
assert(
  draftReviewSource.includes("enableKnowledgeOutlineLinks"),
  "Workbench draft review should enable outline links",
);
assert(
  !draftReviewSource.includes("全文保存会直接使用原文正文"),
  "Workbench copy must not imply full-text capture bypasses final rendering",
);
assert(
  draftReviewSource.includes("生成整理稿并保存")
    && draftReviewSource.includes("全文高保真保存"),
  "Workbench commit actions should describe final rendering before commit",
);

console.log(`knowledge outline navigation contract passed in ${webRoot}`);
