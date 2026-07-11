import assert from "node:assert/strict";

import { resolveKnowledgeDraftReference } from "../src/pages/knowledge-chat/draftRouting.mjs";

const captureId = "bc6408edaf3a";
const readingId = "reading123456";

assert.deepEqual(
  resolveKnowledgeDraftReference(`草稿编号：${captureId}`, {
    captureDraftIds: [captureId],
    readingDraftIds: [],
  }),
  { type: "capture", id: captureId },
);

assert.deepEqual(
  resolveKnowledgeDraftReference(`草稿编号：${readingId}`, {
    captureDraftIds: [],
    readingDraftIds: [readingId],
  }),
  { type: "reading", id: readingId },
);

assert.deepEqual(
  resolveKnowledgeDraftReference(`reading_draft_id: ${readingId}`, {
    captureDraftIds: [readingId],
    readingDraftIds: [readingId],
  }),
  { type: "reading", id: readingId },
);

assert.equal(
  resolveKnowledgeDraftReference("草稿编号：missing12345", {
    captureDraftIds: [captureId],
    readingDraftIds: [readingId],
  }),
  null,
);

assert.equal(
  resolveKnowledgeDraftReference("草稿编号：shared123456", {
    captureDraftIds: ["shared123456"],
    readingDraftIds: ["shared123456"],
  }),
  null,
);

console.log("knowledge draft routing: ok");
