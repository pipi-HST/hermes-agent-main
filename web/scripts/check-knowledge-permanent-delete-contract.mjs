import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const libraryPagePath = fileURLToPath(
  new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url),
);
const libraryHelpersPath = fileURLToPath(
  new URL("../src/pages/knowledge-library/helpers.ts", import.meta.url),
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const apiSource = readFileSync(apiPath, "utf8");
const libraryPageSource = readFileSync(libraryPagePath, "utf8");
const libraryHelpersSource = readFileSync(libraryHelpersPath, "utf8");
const librarySource = `${libraryPageSource}\n${libraryHelpersSource}`;

assert(
  apiSource.includes("deleteKnowledgeLibraryItemPermanent"),
  "API client should expose a permanent delete call",
);
assert(
  apiSource.includes("/permanent"),
  "API client should call the permanent delete endpoint",
);
assert(
  librarySource.includes("deleteDetailPermanent"),
  "Knowledge library page should have a separate permanent delete handler",
);
assert(
  librarySource.includes("isLibraryNotFoundError"),
  "Knowledge library page should treat stale not-found responses after deletion as a cleared selection",
);
assert(
  librarySource.includes("文件已彻底删除。"),
  "Permanent delete should report an already-cleared state as a non-error notice",
);
assert(
  librarySource.includes("getKnowledgeLibraryItemDependencies"),
  "Permanent delete should preview dependencies before deleting",
);
assert(
  librarySource.includes("libraryHasBlockingDependencies"),
  "Permanent delete should block when dependencies exist",
);
const blockingFunction = librarySource.match(
  /function libraryHasBlockingDependencies\([\s\S]*?\n}/,
)?.[0] ?? "";
assert(
  blockingFunction.includes("cardCount") &&
    blockingFunction.includes("gardenDraftCount") &&
    blockingFunction.includes("backlinkCount"),
  "Permanent delete should block on cards, card drafts, and backlinks",
);
assert(
  !blockingFunction.includes("draftCount") && !blockingFunction.includes("eventCount"),
  "Permanent delete should not block on historical drafts or run records",
);
assert(
  librarySource.includes("彻底删除"),
  "UI should expose a clear permanent delete label",
);
assert(
  librarySource.includes("归档"),
  "Committed captures should keep archive as the normal delete action",
);

console.log("knowledge permanent delete contract: ok");
