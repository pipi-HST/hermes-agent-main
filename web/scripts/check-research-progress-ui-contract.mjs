import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const statePath = fileURLToPath(new URL("../src/lib/knowledgeChatState.ts", import.meta.url));
const toolCallPath = fileURLToPath(new URL("../src/components/ToolCall.tsx", import.meta.url));
const markdownPath = fileURLToPath(new URL("../src/components/Markdown.tsx", import.meta.url));
const answerViewPath = fileURLToPath(new URL("../src/components/KnowledgeAnswerView.tsx", import.meta.url));
const gatewayChatPath = fileURLToPath(new URL("../src/pages/knowledge-chat/GatewayChat.tsx", import.meta.url));
const libraryPagePath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url));

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

state = knowledgeChatReducer(initialKnowledgeChatState, {
  type: "tool_start",
  toolId: "call-refs",
  name: "research_with_web",
  context: "AI产品经理和传统产品经理有哪些区别",
});

state = knowledgeChatReducer(state, {
  type: "tool_complete",
  toolId: "call-refs",
  sourceMap: [
    {
      ref: "K3",
      type: "capture_note",
      id: "capture-3",
      item_id: "capture-3",
      item_kind: "capture",
      title: "AI产品经理笔记",
    },
  ],
  retrievedWebSources: Array.from({ length: 21 }, (_, index) => ({
    ref: `W${index + 1}`,
    type: "web",
    title: `网页来源 ${index + 1}`,
    url: `https://example.com/w${index + 1}`,
  })),
});

state = knowledgeChatReducer(state, {
  type: "message_complete",
  id: "assistant-refs",
  text: "核心差异在于模型不确定性 [K3]，以及全生命周期协作 [W16][W21]。",
  createdAt: Date.now(),
});

const assistant = state.messages[state.messages.length - 1];
const refs = assistant.sourceHints.map((source) => source.ref);
const urls = new Map(assistant.sourceHints.map((source) => [source.ref, source.url]));
assert(refs.includes("K3"), "Knowledge citation source should survive");
assert(refs.includes("W16"), "Cited retrieved web source W16 should be promoted");
assert(refs.includes("W21"), "Cited retrieved web source W21 should be promoted");
assert(!refs.includes("W20"), "Uncited retrieved web candidates should not be displayed");
assert(urls.get("W16") === "https://example.com/w16", "Promoted W16 should keep its URL");
assert(urls.get("W21") === "https://example.com/w21", "Promoted W21 should keep its URL");

const historicalToolSummary = `USER_VISIBLE_REPLY:\n历史回答\nSTRUCTURED_AGENT_RESULT_DO_NOT_REWRITE:${JSON.stringify({
  status: "success",
  source_map: [
    {
      ref: "K3",
      type: "capture_note",
      id: "capture-3",
      item_id: "capture-3",
      item_kind: "capture",
      title: "AI产品经理笔记",
    },
  ],
  meta: {
    retrieved_web_sources: Array.from({ length: 21 }, (_, index) => ({
      ref: `W${index + 1}`,
      type: "web",
      title: `历史网页来源 ${index + 1}`,
      url: `https://history.example.com/w${index + 1}`,
    })),
  },
})}`;

state = knowledgeChatReducer(initialKnowledgeChatState, {
  type: "hydrate_messages",
  messages: [
    {
      id: "history-assistant",
      role: "assistant",
      text: "历史恢复需要打开候选池里的网页来源 [W16][W21]。",
      createdAt: Date.now(),
      status: "complete",
    },
  ],
  toolSummaries: [historicalToolSummary],
});

const restored = state.messages[0];
const restoredUrls = new Map(restored.sourceHints.map((source) => [source.ref, source.url]));
assert(restoredUrls.get("W16") === "https://history.example.com/w16", "History hydrate should restore cited W16 URL");
assert(restoredUrls.get("W21") === "https://history.example.com/w21", "History hydrate should restore cited W21 URL");
assert(!restored.sourceHints.some((source) => source.ref === "W20"), "History hydrate should not display uncited retrieved sources");

const historicalKnowledgeSummary = JSON.stringify({
  status: "success",
  source_map: [
    {
      ref: "K3",
      type: "capture_note",
      id: "capture-3",
      item_id: "capture-3",
      item_kind: "capture",
      title: "AI产品经理笔记",
      open_url: "/knowledge-library?kind=capture&item=capture-3",
      file_url: "file:///Users/pipi/Hermes/knowledge/captures/AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86.md",
    },
  ],
});

state = knowledgeChatReducer(initialKnowledgeChatState, {
  type: "hydrate_messages",
  messages: [
    {
      id: "history-knowledge-assistant",
      role: "assistant",
      text: "历史恢复需要打开知识库来源 [K3]。",
      createdAt: Date.now(),
      status: "complete",
    },
  ],
  toolSummaries: [historicalKnowledgeSummary],
});

const restoredKnowledge = state.messages[0].sourceHints[0];
assert(restoredKnowledge.openUrl === "/knowledge-library?kind=capture&item=capture-3", "History hydrate should restore Hermes knowledge open URL");
assert(restoredKnowledge.fileUrl?.startsWith("file://"), "History hydrate should restore file URL");

const manyKnowledgeSources = Array.from({ length: 10 }, (_, index) => ({
  ref: `K${index + 1}`,
  type: "capture_note",
  id: `capture-${index + 1}`,
  item_id: `capture-${index + 1}`,
  item_kind: "capture",
  title: `知识库来源 ${index + 1}`,
  open_url: `/knowledge-library?kind=capture&item=capture-${index + 1}`,
}));
const webSources = Array.from({ length: 3 }, (_, index) => ({
  ref: `W${index + 1}`,
  type: "web",
  title: `正式网页来源 ${index + 1}`,
  url: `https://official.example.com/w${index + 1}`,
}));

state = knowledgeChatReducer(initialKnowledgeChatState, {
  type: "hydrate_messages",
  messages: [
    {
      id: "history-k-heavy-assistant",
      role: "assistant",
      text: "这个历史回答正文只引用知识库来源 [K1][K2][K3][K4]。",
      createdAt: Date.now(),
      status: "complete",
    },
  ],
  toolSummaries: [
    JSON.stringify({
      status: "success",
      source_map: manyKnowledgeSources,
      meta: {
        knowledge_sources: manyKnowledgeSources,
        web_sources: webSources,
      },
    }),
  ],
});

const kHeavyHints = state.messages[0].sourceHints;
assert(kHeavyHints.filter((source) => source.ref?.startsWith("K")).length === 10, "Knowledge sources should keep their per-kind quota");
assert(kHeavyHints.filter((source) => source.ref?.startsWith("W")).length === 3, "Formal web sources should not be squeezed out by K sources");
assert(kHeavyHints.some((source) => source.url === "https://official.example.com/w1"), "History hydrate should keep formal web source URLs even when answer cites only K");

state = knowledgeChatReducer(initialKnowledgeChatState, {
  type: "hydrate_messages",
  messages: [
    {
      id: "history-retrieved-fallback-assistant",
      role: "assistant",
      text: "这个历史回答没有正文网页引用，但它来自联网检索 [K1]。",
      createdAt: Date.now(),
      status: "complete",
    },
  ],
  toolSummaries: [
    JSON.stringify({
      status: "success",
      source_map: [manyKnowledgeSources[0]],
      meta: {
        retrieved_web_sources: Array.from({ length: 8 }, (_, index) => ({
          ref: `W${index + 1}`,
          type: "web",
          title: `候选网页来源 ${index + 1}`,
          url: `https://retrieved.example.com/w${index + 1}`,
        })),
      },
    }),
  ],
});

const fallbackWebHints = state.messages[0].sourceHints.filter((source) => source.ref?.startsWith("W"));
assert(fallbackWebHints.length === 4, "Retrieved web sources should provide a small clickable fallback when formal web sources are missing");
assert(fallbackWebHints[0].url === "https://retrieved.example.com/w1", "Retrieved fallback should preserve URL order");

state = knowledgeChatReducer(initialKnowledgeChatState, {
  type: "hydrate_messages",
  messages: [
    {
      id: "history-knowledge-with-url",
      role: "assistant",
      text: "带原始网页地址的知识库来源仍然应该是知识库引用 [K1]。",
      createdAt: Date.now(),
      status: "complete",
    },
  ],
  toolSummaries: [
    JSON.stringify({
      status: "success",
      source_map: [
        {
          ref: "K1",
          type: "capture_note",
          id: "capture-with-url",
          item_id: "capture-with-url",
          item_kind: "capture",
          title: "带 URL 的知识库来源",
          url: "https://original.example.com/article",
          open_url: "/knowledge-library?kind=capture&item=capture-with-url",
          file_url: "file:///Users/pipi/Hermes/knowledge/captures/with-url.md",
        },
        {
          ref: "W1",
          type: "web",
          title: "网页来源",
          url: "https://web.example.com/source",
        },
      ],
    }),
  ],
});

const knowledgeWithUrlHints = state.messages[0].sourceHints;
const knowledgeWithUrl = knowledgeWithUrlHints.find((source) => source.ref === "K1");
assert(knowledgeWithUrl, "Knowledge source with original URL should keep K ref");
assert(knowledgeWithUrl.openUrl === "/knowledge-library?kind=capture&item=capture-with-url", "Knowledge source with URL should keep Hermes open URL");
assert(knowledgeWithUrl.url === "https://original.example.com/article", "Knowledge source hint may retain original URL as metadata");
assert(knowledgeWithUrlHints.some((source) => source.ref === "W1" && source.url === "https://web.example.com/source"), "Real web source should still keep W ref");

const toolCallSource = readFileSync(toolCallPath, "utf8");
assert(toolCallSource.includes('tool.name === "research_with_web"'), "ToolCall must recognize research_with_web");
assert(toolCallSource.includes("tool.status === \"running\" || hasProgressEvents"), "Research progress should stay visible after completion");
assert(toolCallSource.includes("tool.progressEvents.slice(-10)"), "ToolCall should render recent progress steps");
assert(toolCallSource.includes("检索过程"), "Research tool label should be user-facing");

const markdownSource = readFileSync(markdownPath, "utf8");
assert(markdownSource.includes("{refId}"), "Web citation controls should render the visible ref text");
assert(!markdownSource.includes("<ExternalLink"), "Inline web citations should not be icon-only");

const answerViewSource = readFileSync(answerViewPath, "utf8");
assert(answerViewSource.includes("rewriteCitationRefs(content, displayMap)"), "Answer view should rewrite raw refs to display refs");
assert(answerViewSource.includes("sourceRefAliases(originalRef)"), "Answer view should map original refs to display refs");
assert(answerViewSource.includes("file_url"), "Answer view should render file source links");
assert(answerViewSource.includes("onSourceOpenLocal"), "Answer view should separate local file open from source navigation");
assert(answerViewSource.includes("canOpenKnowledgeSourceLocal"), "Answer view should prefer backend local-open for committed captures");
assert(answerViewSource.includes("source.url && !isKnowledge"), "Knowledge sources with original URLs should still open inside Hermes");

const gatewayChatSource = readFileSync(gatewayChatPath, "utf8");
assert(gatewayChatSource.includes("onSourceOpen={onSourceOpen}"), "Gateway chat should pass source open handler into answer view");
assert(gatewayChatSource.includes("isKnowledgeSourceHint(source)"), "Gateway chat should group sources by source type, not by URL presence");
assert(gatewayChatSource.includes("url: isKnowledge ? undefined : source.url"), "Knowledge citations should not pass original URL as markdown href");

const libraryPageSource = readFileSync(libraryPagePath, "utf8");
assert(libraryPageSource.includes("openKnowledgeSourceLocal"), "Knowledge library should provide a local-open source handler");
assert(libraryPageSource.includes("api.openKnowledgeLibraryItemLocal(\"capture\", itemId)"), "Knowledge source file buttons should call backend open-local");

console.log("research progress UI contract: ok");
