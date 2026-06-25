import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const statePath = fileURLToPath(new URL("../src/lib/knowledgeChatState.ts", import.meta.url));
const toolCallPath = fileURLToPath(new URL("../src/components/ToolCall.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadKnowledgeChatStateModule() {
  const source = readFileSync(statePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: statePath,
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
      throw new Error(`Unexpected runtime import while checking UI contract: ${id}`);
    },
    Date,
  });
  return module.exports;
}

const {
  initialKnowledgeChatState,
  knowledgeChatReducer,
} = loadKnowledgeChatStateModule();

let state = knowledgeChatReducer(initialKnowledgeChatState, {
  type: "tool_start",
  toolId: "call-1",
  name: "research_with_web",
  context: "OpenAI 是什么",
});

state = knowledgeChatReducer(state, {
  type: "tool_progress",
  name: "research_with_web",
  preview: "规划检索任务",
  stage: "planning_start",
  status: "running",
});

state = knowledgeChatReducer(state, {
  type: "tool_progress",
  name: "research_with_web",
  preview: "搜索：OpenAI 是什么",
  stage: "web_query_start",
  status: "running",
});

state = knowledgeChatReducer(state, {
  type: "tool_progress",
  name: "research_with_web",
  preview: "证据裁判完成：采用 1，拒绝 0",
  stage: "evidence_critic_done",
  status: "completed",
});

const tool = state.tools[0];
assert(tool, "Expected a research tool entry");
assert(tool.preview === "证据裁判完成：采用 1，拒绝 0", "Latest preview should stay on the tool row");
assert(tool.progressEvents?.length === 3, "Research progress should append stage history");
assert(tool.progressEvents[0].preview === "规划检索任务", "First progress event was overwritten");
assert(tool.progressEvents[1].stage === "web_query_start", "Stage metadata was not preserved");
assert(tool.progressEvents[2].status === "completed", "Status metadata was not preserved");

const toolCallSource = readFileSync(toolCallPath, "utf8");
assert(toolCallSource.includes('tool.name === "research_with_web"'), "ToolCall must recognize research_with_web");
assert(toolCallSource.includes("tool.status === \"running\" || hasProgressEvents"), "Research progress should stay visible after completion");
assert(toolCallSource.includes("tool.progressEvents.slice(-10)"), "ToolCall should render recent progress steps");
assert(toolCallSource.includes("检索过程"), "Research tool label should be user-facing");

console.log("research progress UI contract: ok");
