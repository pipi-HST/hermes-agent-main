import type { KnowledgeLibraryItem } from "@/lib/api";
import { isoTimeAgo } from "@/lib/utils";

export type LibrarySelection =
  | { type: "all"; value: "all" }
  | { type: "folder"; value: string }
  | { type: "view"; value: string };

export type StatusFilter = "all" | "draft" | "in_library" | "searchable" | "cards";

export const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "in_library", label: "已入库" },
  { key: "searchable", label: "可检索" },
  { key: "cards", label: "有卡片" },
];

export const KNOWLEDGE_LEFT_WIDTH_KEY = "hermes.knowledgeLibrary.leftWidth";
export const DEFAULT_KNOWLEDGE_LEFT_WIDTH = 360;

export function itemKey(item: KnowledgeLibraryItem): string {
  return `${item.kind}:${item.id}`;
}

export function formatIso(value: string): string {
  if (!value) return "未知时间";
  return isoTimeAgo(value);
}
