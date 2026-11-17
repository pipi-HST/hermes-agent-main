import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const statePath = fileURLToPath(new URL("../src/lib/knowledgeChatState.ts", import.meta.url));
const chatPagePath = fileURLToPath(new URL("../src/pages/KnowledgeChatPage.tsx", import.meta.url));
const draftReviewPath = fileURLToPath(new URL("../src/pages/knowledge-chat/DraftReview.tsx", import.meta.url));
const gatewayChatPath = fileURLToPath(new URL("../src/pages/knowledge-chat/GatewayChat.tsx", import.meta.url));
const toolCallPath = fileURLToPath(new URL("../src/components/ToolCall.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const apiSource = readFileSync(apiPath, "utf8");
const stateSource = readFileSync(statePath, "utf8");
const chatPageSource = readFileSync(chatPagePath, "utf8");
const draftReviewSource = readFileSync(draftReviewPath, "utf8");
const gatewayChatSource = readFileSync(gatewayChatPath, "utf8");
const toolCallSource = readFileSync(toolCallPath, "utf8");

assert(
  apiSource.includes("reviseKnowledgeCaptureDraft:"),
  "API client should keep draft revision support for uncommitted capture drafts",
);
assert(
  chatPageSource.includes("reviseKnowledgeCaptureDraft"),
  "Knowledge workbench should still send AI revision instructions for open drafts",
);
assert(
  chatPageSource.includes("useNavigate"),
  "Knowledge workbench should use router navigation for committed capture edits",
);
assert(
  chatPageSource.includes("/knowledge-library?kind=capture&item="),
  "Committed capture edit action should jump to the knowledge library item route",
);
assert(
  chatPageSource.includes("&mode=edit"),
  "Committed capture edit route should request knowledge library edit mode",
);
assert(
  draftReviewSource.includes("去资料库编辑"),
  "Committed draft UI should expose a knowledge-library edit action",
);
assert(
  draftReviewSource.includes("这份材料已保存。需要调整内容时，请进入资料库编辑页。"),
  "Committed draft UI should explain that edits now happen in the library",
);
assert(
  draftReviewSource.includes("原文已提取，正在等待确认。确认后再生成高保真 Markdown 正文并保存。"),
  "Raw extracted capture drafts should be shown as awaiting confirmation, not final drafts",
);
assert(
  draftReviewSource.includes('detail.status === "raw_extracted" && !hasFinalDraft'),
  "Workbench should distinguish raw-only drafts before finalization",
);
assert(
  stateSource.includes("interruptRequested: boolean"),
  "Knowledge workbench state should track an interrupt request separately from running",
);
assert(
  stateSource.includes('{ type: "interrupt_requested" }'),
  "Knowledge workbench reducer should expose a lightweight interrupt_requested action",
);
assert(
  chatPageSource.includes('gw.request("session.interrupt"'),
  "Knowledge workbench stop action should continue using the existing session.interrupt RPC",
);
assert(
  chatPageSource.includes('dispatch({ type: "interrupt_requested" })'),
  "Knowledge workbench should mark stop requests immediately for visible feedback",
);
assert(
  chatPageSource.includes("state.interruptRequested ? \"正在停止\" : \"思考中\""),
  "Knowledge workbench status pill should show a stopping state after stop is clicked",
);
assert(
  gatewayChatSource.includes("disabled={running ? interruptRequested : !canSend}"),
  "Knowledge workbench stop button should prevent duplicate stop clicks while interrupt is pending",
);
assert(
  gatewayChatSource.includes("正在停止"),
  "Knowledge workbench stop button should expose a visible stopping label",
);
assert(
  stateSource.includes("toolProgressEventsFromSummary"),
  "Knowledge workbench should derive tool detail steps from structured tool summaries",
);
assert(
  stateSource.includes("stage_timings_ms"),
  "Knowledge workbench tool details should surface backend stage timings",
);
assert(
  chatPageSource.includes("progressEvents: toolProgressEventsFromSummary"),
  "Knowledge workbench history hydration should keep parsed tool detail steps",
);
assert(
  toolCallSource.includes('tool.status === "running" || hasProgressEvents'),
  "ToolCall should auto-expand running tools and tools with parsed progress events",
);
assert(
  !chatPageSource.includes("reviseCommittedCapture"),
  "Knowledge workbench should not request committed capture AI revisions",
);
assert(
  !chatPageSource.includes("applyCommittedRevision"),
  "Knowledge workbench should not apply committed capture revisions",
);
assert(
  !draftReviewSource.includes("AI 修订预览"),
  "Committed draft UI should not render an AI revision preview",
);
assert(
  !draftReviewSource.includes("应用修订"),
  "Committed draft UI should not expose an apply revision action",
);

console.log("knowledge AI revision workbench contract: ok");
