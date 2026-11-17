import type {
  KnowledgeCaptureDraft,
  KnowledgeGardenDraftResponse,
  KnowledgeLibraryDeleteResponse,
  KnowledgeLibraryDependencies,
  KnowledgeLibraryItem,
  KnowledgeLibrarySmartView,
} from "@/lib/api";
import type { LibrarySelection, StatusFilter } from "./model";

export const LIBRARY_NOT_FOUND_PATTERNS = [
  "Library capture not found",
  "Library draft not found",
  "Capture not found",
  "Capture draft not found",
];

export function isLibraryNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith("404:") && LIBRARY_NOT_FOUND_PATTERNS.some((pattern) => message.includes(pattern));
}

export function isAiCancelledResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.cancelled === true || record.status === "cancelled";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function bridgeMetaString(result: Record<string, unknown>, key: string): string {
  const direct = result[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const meta = result.meta;
  if (meta && typeof meta === "object") {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function parseTagsText(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeGardenCardKind(value: string): string {
  const kind = value.trim().toLowerCase();
  if (["viewpoint", "method", "fact", "risk"].includes(kind)) return kind;
  if (kind.includes("方法")) return "method";
  if (kind.includes("事实")) return "fact";
  if (kind.includes("风险")) return "risk";
  return kind ? "viewpoint" : "";
}

export function normalizeCardSuggestions(value: unknown): Array<{ title: string; card_kind: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const card = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        title: stringValue(card.title),
        card_kind: normalizeGardenCardKind(stringValue(card.card_kind)),
        reason: stringValue(card.reason),
      };
    })
    .filter((card) => card.title || card.reason)
    .slice(0, 8);
}

export function formatEditableCardSuggestions(value: unknown): string {
  return normalizeCardSuggestions(value)
    .map((card) => [card.title, card.card_kind, card.reason].filter(Boolean).join(" | "))
    .join("\n");
}

export function editableFolderSuggestion(intent: Record<string, unknown> | undefined): {
  mode: "existing" | "new";
  folder_path: string;
  reason: string;
} {
  const raw = intent?.folder_suggestion;
  const suggestion = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = suggestion.mode === "new" ? "new" : "existing";
  const folderPath = stringValue(suggestion.folder_path) || stringValue(intent?.folder_path) || "Inbox";
  return {
    mode,
    folder_path: folderPath,
    reason: stringValue(suggestion.reason) || "AI 未返回明确文件夹建议，先放入 Inbox 等待人工确认。",
  };
}

export function editableCardSuggestion(intent: Record<string, unknown> | undefined): {
  should_generate: boolean;
  reason: string;
  cards: Array<{ title: string; card_kind: string; reason: string }>;
} {
  const raw = intent?.card_suggestion;
  const suggestion = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const reason = stringValue(suggestion.reason);
  return {
    should_generate: suggestion.should_generate === true && Boolean(reason),
    reason: reason || "AI 未返回有效卡片建议，默认暂不生成 Garden Card。",
    cards: normalizeCardSuggestions(suggestion.cards),
  };
}

export function editableAiSuggestionsStatus(draft: KnowledgeCaptureDraft): "generated" | "failed" | "not_generated" {
  const value = String(draft.capture_intent?.ai_suggestions_status || "");
  if (value === "generated" || value === "failed") return value;
  return "not_generated";
}

export function editableDraftTitleSource(draft: KnowledgeCaptureDraft): "ai" | "user" {
  const source = draft.capture_intent?.title_source === "user" ? "user" : "ai";
  if (
    source === "user" &&
    editableAiSuggestionsStatus(draft) !== "generated" &&
    isGenericEditableTitle(draft.title || "")
  ) {
    return "ai";
  }
  return source;
}

export function isGenericEditableTitle(title: string): boolean {
  return /^(?:整理稿|文字稿|未命名|无标题)(?:[ _-]?(?:副本|copy)|[（(]\d+[）)]|[ _-]?\d+)?$/i.test(title.trim());
}

export function parseCardSuggestionsText(text: string): Array<{ title: string; card_kind: string; reason: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      return {
        title: parts[0] || "",
        card_kind: normalizeGardenCardKind(parts[1] || ""),
        reason: parts.slice(2).join(" | ") || parts[1] || "",
      };
    })
    .filter((card) => card.title || card.reason)
    .slice(0, 8);
}

export function firstGardenCardHint(text: string): { title?: string; card_kind?: string } {
  const [first] = parseCardSuggestionsText(text);
  return {
    title: first?.title || undefined,
    card_kind: first?.card_kind || undefined,
  };
}

export function buildGardenDraftInstruction(reason: string, suggestionsText: string): string {
  const parts = [];
  if (reason.trim()) parts.push(`生成理由：${reason.trim()}`);
  if (suggestionsText.trim()) parts.push(`建议生成哪些卡：\n${suggestionsText.trim()}`);
  return parts.join("\n\n");
}

export function gardenDraftNotice(result: KnowledgeGardenDraftResponse): string {
  const title = result.meta?.title;
  if (typeof title === "string" && title.trim()) {
    return `已生成知识卡片：《${title.trim()}》。`;
  }
  const previewLine = (result.chat_preview || result.USER_VISIBLE_REPLY || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return previewLine || "已生成知识卡片。";
}

export function gardenDraftError(result: KnowledgeGardenDraftResponse): string {
  return result.error || result.errors?.[0] || result.USER_VISIBLE_REPLY || result.chat_preview || "生成知识卡片失败。";
}

export function libraryDependencyCounts(dependencies?: KnowledgeLibraryDependencies): {
  cardCount: number;
  gardenDraftCount: number;
  draftCount: number;
  backlinkCount: number;
  eventCount: number;
} {
  return {
    cardCount: dependencies?.garden_cards?.length ?? 0,
    gardenDraftCount: dependencies?.garden_drafts?.length ?? 0,
    draftCount: dependencies?.committed_drafts?.length ?? 0,
    backlinkCount: dependencies?.backlinks?.length ?? 0,
    eventCount: dependencies?.event_count ?? 0,
  };
}

export function libraryDeleteNotice(result: KnowledgeLibraryDeleteResponse): string {
  const dependencies = result.dependencies;
  if (!dependencies) return result.message || "已归档保存文件。";
  const { cardCount, gardenDraftCount, backlinkCount, draftCount, eventCount } = libraryDependencyCounts(dependencies);
  const parts = [
    cardCount ? `${cardCount} 张卡片` : "",
    gardenDraftCount ? `${gardenDraftCount} 条卡片草稿` : "",
    backlinkCount ? `${backlinkCount} 个引用` : "",
    draftCount ? `${draftCount} 条历史草稿` : "",
    eventCount ? `${eventCount} 条运行记录` : "",
  ].filter(Boolean);
  if (!parts.length) return "已归档保存文件，保留源文件和数据库记录。";
  return `已归档保存文件，保留源文件、数据库记录、${parts.join("、")}。`;
}

export function libraryDeleteConfirmMessage(
  item: KnowledgeLibraryItem,
  dependencies?: KnowledgeLibraryDependencies,
): string {
  if (item.kind !== "capture") {
    return `确定删除草稿《${item.title || "未命名草稿"}》吗？`;
  }
  const counts = libraryDependencyCounts(dependencies);
  return [
    `确定从资料库移除《${item.title || "未命名文件"}》吗？`,
    "",
    "这不是物理删除：文件会标记为归档并从资料库列表隐藏。",
    "",
    "将保留：",
    "- 本地正文和来源记录",
    `- Knowledge Card：${counts.cardCount} 张`,
    `- 卡片草稿：${counts.gardenDraftCount} 条`,
    `- 历史草稿：${counts.draftCount} 条`,
    `- 其他文件引用：${counts.backlinkCount} 个`,
    `- 运行记录：${counts.eventCount} 条`,
    "- 数据库 capture 行：保留，状态改为 archived",
  ].join("\n");
}

export function libraryHasBlockingDependencies(dependencies?: KnowledgeLibraryDependencies): boolean {
  const counts = libraryDependencyCounts(dependencies);
  return counts.cardCount > 0 ||
    counts.gardenDraftCount > 0 ||
    counts.backlinkCount > 0;
}

export function libraryPermanentDeleteBlockedMessage(
  item: KnowledgeLibraryItem,
  dependencies?: KnowledgeLibraryDependencies,
): string {
  const counts = libraryDependencyCounts(dependencies);
  const parts = [
    counts.cardCount ? `${counts.cardCount} 张知识卡片` : "",
    counts.gardenDraftCount ? `${counts.gardenDraftCount} 条卡片草稿` : "",
    counts.backlinkCount ? `${counts.backlinkCount} 个文件引用` : "",
  ].filter(Boolean);
  const reason = parts.length ? parts.join("、") : "其他知识对象";
  return `无法彻底删除《${item.title || "未命名文件"}》：仍被 ${reason} 引用。请先解除引用，或使用“归档”。`;
}

export function libraryPermanentDeleteConfirmMessage(
  item: KnowledgeLibraryItem,
  dependencies?: KnowledgeLibraryDependencies,
): string {
  const counts = libraryDependencyCounts(dependencies);
  const traceLines = [
    counts.draftCount ? `- 历史草稿指针：${counts.draftCount} 条，将解绑` : "",
    counts.eventCount ? `- 运行对象索引：${counts.eventCount} 条，将删除` : "",
  ].filter(Boolean);
  return [
    `确定彻底删除《${item.title || "未命名文件"}》吗？`,
    "",
    "这会删除本地 Markdown 正文、raw 来源文件、数据库 capture 行和本地索引记录。",
    "只有在没有活跃知识卡片、待提交卡片草稿和其他文件引用时才允许执行。",
    ...(traceLines.length ? ["", "历史草稿和运行记录不是硬阻断，会同步清理：", ...traceLines] : []),
    "",
    "此操作不可从 Hermes UI 恢复。",
  ].join("\n");
}

export function libraryPermanentDeleteNotice(result: { message?: string }): string {
  return result.message || "已彻底删除保存文件。";
}

export function groupItemsByFolder(items: KnowledgeLibraryItem[]): Map<string, KnowledgeLibraryItem[]> {
  const grouped = new Map<string, KnowledgeLibraryItem[]>();
  for (const item of items) {
    const folder = item.folder_path || "Inbox";
    grouped.set(folder, [...(grouped.get(folder) ?? []), item]);
  }
  for (const [folder, folderItems] of grouped.entries()) {
    grouped.set(folder, [...folderItems].sort(compareItemsByUpdatedAt));
  }
  return grouped;
}

export function compareItemsByUpdatedAt(a: KnowledgeLibraryItem, b: KnowledgeLibraryItem): number {
  return Date.parse(b.updated_at || b.created_at || "0") - Date.parse(a.updated_at || a.created_at || "0");
}

export function matchesStatusFilter(item: KnowledgeLibraryItem, filter: StatusFilter): boolean {
  if (filter === "draft") return item.kind === "capture_draft";
  if (filter === "in_library") return item.kind === "capture";
  if (filter === "searchable") return item.indexed;
  if (filter === "cards") return item.garden_card_count > 0;
  return true;
}

export function selectionLabel(selection: LibrarySelection, views: KnowledgeLibrarySmartView[]): string {
  if (selection.type === "all") return "所有文件";
  if (selection.type === "folder") return selection.value;
  return views.find((view) => view.key === selection.value)?.label ?? "处理队列";
}
