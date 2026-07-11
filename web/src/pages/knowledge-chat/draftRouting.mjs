/**
 * @typedef {{ type: "capture" | "reading", id: string }} KnowledgeDraftReference
 * @typedef {{
 *   captureDraftIds: Iterable<string>,
 *   readingDraftIds: Iterable<string>,
 * }} KnowledgeDraftReferenceOptions
 */

/**
 * @param {string} text
 * @returns {{ type: KnowledgeDraftReference["type"] | null, id: string } | null}
 */
function extractDraftIdCandidate(text) {
  const patterns = [
    { type: "reading", pattern: /reading_draft_id["'\s:：]+([a-zA-Z0-9_-]{8,})/i },
    { type: "capture", pattern: /capture_draft_id["'\s:：]+([a-zA-Z0-9_-]{8,})/i },
    { type: null, pattern: /草稿编号[：:\s]+([a-zA-Z0-9_-]{8,})/ },
    { type: null, pattern: /(?<![a-zA-Z0-9_])draft_id["'\s:：]+([a-zA-Z0-9_-]{8,})/i },
  ];
  for (const { type, pattern } of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return { type, id: match[1] };
  }
  return null;
}

/**
 * @param {string} text
 * @param {KnowledgeDraftReferenceOptions} options
 * @returns {KnowledgeDraftReference | null}
 */
export function resolveKnowledgeDraftReference(text, options) {
  const candidate = extractDraftIdCandidate(text);
  if (!candidate) return null;

  const captureDraftIds = new Set(options.captureDraftIds);
  const readingDraftIds = new Set(options.readingDraftIds);
  const isCapture = captureDraftIds.has(candidate.id);
  const isReading = readingDraftIds.has(candidate.id);

  if (candidate.type === "capture") {
    return isCapture ? { type: "capture", id: candidate.id } : null;
  }
  if (candidate.type === "reading") {
    return isReading ? { type: "reading", id: candidate.id } : null;
  }
  if (isCapture === isReading) return null;
  return {
    type: isCapture ? "capture" : "reading",
    id: candidate.id,
  };
}
