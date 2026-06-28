import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const chatPagePath = fileURLToPath(new URL("../src/pages/KnowledgeChatPage.tsx", import.meta.url));
const draftReviewPath = fileURLToPath(new URL("../src/pages/knowledge-chat/DraftReview.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const apiSource = readFileSync(apiPath, "utf8");
const chatPageSource = readFileSync(chatPagePath, "utf8");
const draftReviewSource = readFileSync(draftReviewPath, "utf8");

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
  draftReviewSource.includes("去知识库编辑"),
  "Committed draft UI should expose a knowledge-library edit action",
);
assert(
  draftReviewSource.includes("这份材料已入库。需要调整内容时，请进入知识库编辑页。"),
  "Committed draft UI should explain that edits now happen in the library",
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
