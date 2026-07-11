export type KnowledgeDraftReference = {
  type: "capture" | "reading";
  id: string;
};

export function resolveKnowledgeDraftReference(
  text: string,
  options: {
    captureDraftIds: Iterable<string>;
    readingDraftIds: Iterable<string>;
  },
): KnowledgeDraftReference | null;
