import assert from "node:assert/strict";

globalThis.window = { __HERMES_SESSION_TOKEN__: "" };

const { api, KnowledgeSelectionChatStreamError } = await import("../src/lib/api.ts");
const { articleQuestionForMessage } = await import("../src/pages/knowledge-library/helpers.ts");

const requestBody = {
  question: "问题",
  selected_text: "",
  surrounding_before: "",
  surrounding_after: "",
  heading_path: [],
  selection_confidence: "none",
  mode: "current_article_only",
};
const requestStream = () => api.streamSelectionChatKnowledgeLibraryItem(
  "capture",
  "item-1",
  requestBody,
  () => {},
);

// A missing stream endpoint can fall back to the plain endpoint.
globalThis.fetch = async () => new Response("stream unavailable", { status: 404 });
await assert.rejects(
  requestStream,
  (error) => error instanceof KnowledgeSelectionChatStreamError && !error.requestAccepted,
);

// A 5xx, a network failure, or a stream that ends early may still have been
// accepted by the service. Replaying those would duplicate the answer.
for (const fetchImpl of [
  async () => new Response("already timed out", { status: 408 }),
  async () => new Response("rate limit", { status: 429 }),
  async () => new Response("server error", { status: 502 }),
  async () => { throw new TypeError("network dropped"); },
  async () => new Response('data: {"event":"progress"}\n\n', { status: 200 }),
]) {
  globalThis.fetch = fetchImpl;
  await assert.rejects(
    requestStream,
    (error) => error instanceof KnowledgeSelectionChatStreamError && error.requestAccepted,
  );
}

const messages = [
  { id: "u1", role: "user", content: "第一个问题", requestContext: { question: "第一个问题" } },
  { id: "a1", role: "assistant", content: "第一个回答", requestContext: { question: "第一个问题" } },
  { id: "u2", role: "user", content: "较新的问题" },
  { id: "a2", role: "assistant", content: "较早回答" },
  { id: "u3", role: "user", content: "最新问题" },
  { id: "a3", role: "assistant", content: "最新回答" },
];

assert.equal(articleQuestionForMessage(messages, messages[1]), "第一个问题");
assert.equal(articleQuestionForMessage(messages, messages[3]), "较新的问题");
assert.equal(articleQuestionForMessage(messages, messages[5]), "最新问题");
assert.equal(
  articleQuestionForMessage([{ id: "x", role: "assistant", content: "无配对回答" }], {
    id: "x",
    role: "assistant",
    content: "无配对回答",
  }),
  "",
);

console.log("knowledge selection stream fallback: ok");
