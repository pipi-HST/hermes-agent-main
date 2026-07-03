import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const chatPagePath = fileURLToPath(new URL("../src/pages/KnowledgeChatPage.tsx", import.meta.url));
const libraryPagePath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url));
const editablePath = fileURLToPath(new URL("../src/pages/knowledge-chat/EditableCaptureWorkbench.tsx", import.meta.url));
const draftReviewPath = fileURLToPath(new URL("../src/pages/knowledge-chat/DraftReview.tsx", import.meta.url));
const readingReviewPath = fileURLToPath(new URL("../src/pages/knowledge-chat/ReadingDraftReview.tsx", import.meta.url));
const gatewayChatPath = fileURLToPath(new URL("../src/pages/knowledge-chat/GatewayChat.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const apiSource = readFileSync(apiPath, "utf8");
const chatSource = readFileSync(chatPagePath, "utf8");
const librarySource = readFileSync(libraryPagePath, "utf8");
const editableSource = readFileSync(editablePath, "utf8");
const draftReviewSource = readFileSync(draftReviewPath, "utf8");
const readingReviewSource = readFileSync(readingReviewPath, "utf8");
const gatewayChatSource = readFileSync(gatewayChatPath, "utf8");

assert(apiSource.includes("X-Hermes-AI-Operation-Id"), "API client should attach AI operation ids");
assert(apiSource.includes("cancelKnowledgeAiOperation"), "API client should expose AI operation cancel");
assert(apiSource.includes("/api/knowledge/ai-operations/"), "API client should call the cancel endpoint");

for (const [label, source] of [
  ["KnowledgeChatPage", chatSource],
  ["KnowledgeLibraryPage", librarySource],
]) {
  assert(source.includes("createAiOperationId"), `${label} should create AI operation ids`);
  assert(source.includes("AbortController"), `${label} should create AbortController for AI operations`);
  assert(source.includes("controller.abort()"), `${label} stop should abort the local fetch immediately`);
  assert(source.includes("isCancelled"), `${label} should expose a stale-result guard for cancelled operations`);
  assert(source.includes("cancelKnowledgeAiOperation"), `${label} should call operation cancel`);
  assert(source.includes("isAiCancelledResult"), `${label} should handle cancelled backend responses`);
  assert(source.includes("已请求停止"), `${label} should show immediate stopped feedback`);
  assert(source.includes("signal: operation.signal"), `${label} should pass AbortSignal to cancellable requests`);
}

for (const [label, source] of [
  ["EditableCaptureWorkbench", editableSource],
  ["DraftReview", draftReviewSource],
  ["ReadingDraftReview", readingReviewSource],
]) {
  assert(source.includes("onStopAiOperation"), `${label} should receive a stop callback`);
  assert(source.includes("stoppingAiOperation"), `${label} should prevent duplicate stop clicks`);
  assert(source.includes("SquareStop"), `${label} should render a stop icon`);
  assert(source.includes("停止"), `${label} should expose a visible stop label`);
}

assert(
  chatSource.includes('gw.request("session.interrupt"'),
  "Workbench chat stop should keep using the existing session.interrupt RPC",
);
assert(
  gatewayChatSource.includes("interruptRequested"),
  "Gateway chat should keep its existing stopping state",
);
assert(
  librarySource.includes("chatStreamAbortRef") && librarySource.includes("stopArticleAi"),
  "Article AI SSE stop should remain wired to AbortController",
);

console.log("knowledge AI stop contract: ok");
