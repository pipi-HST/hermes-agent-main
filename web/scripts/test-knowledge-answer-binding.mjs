import assert from "node:assert/strict";
import { initialKnowledgeChatState, knowledgeChatReducer } from "../src/lib/knowledgeChatState.ts";

let state = initialKnowledgeChatState;
const dispatch = (action) => { state = knowledgeChatReducer(state, action); };
const submit = (id) => dispatch({ type: "submit_user", id, text: "question", createdAt: 0 });
const complete = (id, text) => dispatch({ type: "message_complete", id, text, createdAt: 1 });
const tool = {
  type: "tool_complete",
  toolId: "first-search",
  answerText: "First answer [W1]",
  sourceRunId: "first-run",
  sourceMap: [{ type: "web", ref: "W1", title: "First source", url: "https://example.test/first" }],
};

submit("question-1");
dispatch({ type: "tool_start", toolId: tool.toolId, name: "research_with_web" });
dispatch(tool);
complete("answer-1", "First preview");
assert.equal(state.messages.at(-1).text, tool.answerText);
assert.equal(state.messages.at(-1).sourceRunId, "first-run");
assert.ok(state.messages.at(-1).sourceHints.some((item) => item.url === "https://example.test/first"));

submit("question-2");
dispatch(tool);
complete("answer-2", "Second answer");
assert.equal(state.messages.at(-1).text, "Second answer");
assert.equal(state.messages.at(-1).sourceRunId, undefined);
assert.deepEqual(state.messages.at(-1).sourceHints, []);

dispatch({ type: "hydrate_messages", messages: state.messages, tools: state.tools });
assert.deepEqual(state.messages.at(-1).sourceHints, []);
console.log("knowledge answer binding: ok");
