import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const chatPagePath = fileURLToPath(new URL("../src/pages/KnowledgeChatPage.tsx", import.meta.url));
const gatewayChatPath = fileURLToPath(new URL("../src/pages/knowledge-chat/GatewayChat.tsx", import.meta.url));
const libraryPagePath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

const api = readFileSync(apiPath, "utf8");
const chatPage = readFileSync(chatPagePath, "utf8");
const gatewayChat = readFileSync(gatewayChatPath, "utf8");
const libraryPage = readFileSync(libraryPagePath, "utf8");

// 1. API contract: web_only stays a valid persisted/response mode.
const apiMode = blockBetween(api, "export type KnowledgeResearchMode =", ";");
assert(apiMode.includes('"web_only"'), "KnowledgeResearchMode must keep web_only for API/eval compatibility");

// 2. UI-selectable contract: users can never originate web_only.
const selectableMode = blockBetween(
  api,
  "export type KnowledgeSelectableResearchMode =",
  ";",
);
assert(
  !selectableMode.includes("web_only"),
  "KnowledgeSelectableResearchMode must not expose web_only to the UI",
);

// 3. Main chat: only local_only / local_web / theme_scan are selectable.
const toolsets = blockBetween(chatPage, "const KNOWLEDGE_TOOLSETS_BY_MODE", "};");
assert(!/\bweb_only\s*:/.test(toolsets), "KNOWLEDGE_TOOLSETS_BY_MODE must not define web_only");

// 4. Main chat control: the web toggle only switches local_only <> local_web.
assert(!gatewayChat.includes("web_only"), "GatewayChat must not reference web_only");

// 5. Article companion control: only current_article_only <> local_web.
const researchModeControl = blockBetween(libraryPage, "function ResearchModeControl(", "\nfunction ");
assert(
  !researchModeControl.includes("web_only"),
  "ResearchModeControl must not expose web_only",
);
assert(
  researchModeControl.includes('const webEnabled = mode === "local_web";'),
  "ResearchModeControl must treat only local_web as web-enabled",
);

console.log("knowledge research mode contract: ok");
