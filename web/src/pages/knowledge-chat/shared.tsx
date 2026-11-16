import React from "react";
import {
  CheckCircle2,
  CircleDot,
  Loader2,
} from "lucide-react";
import type {
  KnowledgeCaptureDraft,
  KnowledgeObjectEvent,
  KnowledgeObjectEventType,
  KnowledgeReadingDraft,
} from "@/lib/api";
import type { ToolEntry } from "@/components/ToolCall";
import type { KnowledgeSourceHint } from "@/lib/knowledgeChatState";
import { cn } from "@/lib/utils";

export const OPEN_STATUSES = new Set([
  "open",
  "raw_extracted",
  "draft_ready",
  "revision_requested",
  "draft_incomplete",
]);

export const HIDDEN_DRAFT_STATUSES = new Set(["abandoned", "discarded"]);

export const DRAFT_FILTERS = [
  { key: "open", label: "待审" },
  { key: "all", label: "全部" },
  { key: "committed", label: "已入库" },
] as const;

export type DraftFilterKey = (typeof DRAFT_FILTERS)[number]["key"];
export type WorkbenchMode = "chat" | "editable_capture" | "draft_review" | "answer_draft_review" | "source" | "result";
export type AnswerOutputType = "auto" | "local_learning_note" | "knowledge_card" | "enhance_capture";
export type AnswerDraftActionLoading = "create" | "commit" | "revise" | "delete" | "card" | null;
export type DraftView = "draft" | "raw" | "meta";
export type InspectorTab = "sources" | "tools" | "status";
export type InspectorObjectRef = { type: KnowledgeObjectEventType; id: string; label: string } | null;

export type WorkbenchSelection =
  | { type: "conversation"; sessionId: string }
  | { type: "draft"; draftId: string }
  | { type: "material"; captureId: string }
  | { type: "card"; cardId: string };

export interface ComposerAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

export function readingDraftCaptureId(draft: KnowledgeReadingDraft | null): string {
  const metaCaptureId = draft?.meta?.capture_id;
  if (typeof metaCaptureId === "string" && metaCaptureId.trim()) {
    return metaCaptureId.trim();
  }
  return draft?.target_capture_id?.trim() ?? "";
}

export function sourceHintsFromMetaSources(draft: KnowledgeReadingDraft): KnowledgeSourceHint[] {
  const sources = Array.isArray(draft.meta?.sources) ? draft.meta.sources : [];
  return sources.flatMap((source, index) => {
    if (!source || typeof source !== "object") return [];
    const record = source as Record<string, unknown>;
    const label = stringValue(record.title) || stringValue(record.label) || stringValue(record.id) || stringValue(record.source_id);
    if (!label) return [];
    return [{
      id: `reading-source-${draft.id}-${index}`,
      label,
      origin: "answer" as const,
      url: stringValue(record.url) || undefined,
      excerpt: stringValue(record.excerpt) || undefined,
      sourceType: stringValue(record.type) || undefined,
    }];
  });
}

export function sourceHintsFromCaptureDraft(draft: KnowledgeCaptureDraft): KnowledgeSourceHint[] {
  const label = draft.source || draft.title || draft.committed_capture_id || draft.id;
  if (!label) return [];
  return [{
    id: `capture-source-${draft.id}`,
    label,
    origin: "answer" as const,
    excerpt: draft.summary || draft.draft_preview || draft.raw_preview || undefined,
    sourceType: draft.source_type || "capture",
  }];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function objectEventToToolEntry(event: KnowledgeObjectEvent): ToolEntry {
  return {
    kind: "tool",
    id: `object-event-${event.id}`,
    tool_id: event.id,
    name: `${event.agent}.${event.intent}`,
    context: event.trigger || event.created_at || undefined,
    summary: objectEventSummary(event),
    error: event.errors?.join("\n") || undefined,
    status: event.status === "error" || event.errors?.length ? "error" : "done",
    startedAt: 0,
  };
}

function objectEventSummary(event: KnowledgeObjectEvent): string {
  const parts: string[] = [];
  parts.push(`状态：${event.status || "unknown"}`);
  if (event.completed_at) parts.push(`完成时间：${event.completed_at}`);
  if (Object.keys(event.input || {}).length) {
    parts.push(`输入：${JSON.stringify(event.input, null, 2)}`);
  }
  if (Object.keys(event.output || {}).length) {
    parts.push(`输出：${JSON.stringify(event.output, null, 2)}`);
  }
  if (Object.keys(event.evidence || {}).length) {
    parts.push(`证据：${JSON.stringify(event.evidence, null, 2)}`);
  }
  if (event.warnings?.length) {
    parts.push(`警告：${event.warnings.join("\n")}`);
  }
  return parts.join("\n\n");
}

export function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-current/10 bg-background/50 px-2 py-1 text-xs text-muted-foreground">
      <CircleDot className="h-3.5 w-3.5 text-primary/80" />
      <span className="truncate">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

export function ActionButton({
  children,
  disabled,
  loading,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-primary/45 bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-[0_12px_30px_rgba(0,0,0,0.22)] transition hover:brightness-110 disabled:border-current/10 disabled:bg-muted/40 disabled:text-muted-foreground"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const open = OPEN_STATUSES.has(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[0.68rem] uppercase tracking-[0.12em]",
        open
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-current/10 bg-background/55 text-muted-foreground",
      )}
      title={status}
    >
      {statusLabel(status)}
    </span>
  );
}

export function TinyPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-current/10 bg-background/55 px-2 py-0.5 text-[0.72rem] leading-5 text-muted-foreground">
      {children}
    </span>
  );
}

export function LoadingBlock({ text }: { text: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
  );
}

export function PanelEmpty({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/45 px-3 py-4 text-sm leading-6 text-muted-foreground">
      {text}
    </div>
  );
}

export function InfoGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid gap-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-md border border-current/10 bg-background/45 p-3">
          <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words text-sm leading-5 text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function intentLabel(intent: string): string {
  return ({
    verbatim_full_text: "全文保存",
    full_text: "全文保存",
    summary: "精炼总结",
    focus_extract: "重点提取",
    enhanced_note: "原文增强",
  } as Record<string, string>)[intent] ?? (intent || "未识别");
}

export function answerDraftTypeLabel(type: string): string {
  return ({
    local_learning_note: "资料笔记",
    knowledge_card: "知识卡片",
    enhance_capture: "主笔记增强",
  } as Record<string, string>)[type] ?? "回答沉淀";
}

export function statusLabel(status: string): string {
  return ({
    open: "待保存",
    raw_extracted: "待确认",
    draft_ready: "待审阅",
    revision_requested: "修改中",
    draft_incomplete: "未完成",
    committed: "已入库",
    abandoned: "已删除",
    discarded: "已删除",
  } as Record<string, string>)[status] ?? (status || "未知");
}

export function modeLabel(mode: WorkbenchMode): string {
  return ({
    chat: "对话",
    editable_capture: "粘贴整理",
    draft_review: "草稿审阅",
    answer_draft_review: "回答沉淀",
    source: "原文查看",
    result: "结果报告",
  } as Record<WorkbenchMode, string>)[mode];
}

export function selectionLabel(selection: WorkbenchSelection): string {
  if (selection.type === "conversation") return "当前对话";
  if (selection.type === "draft") return "草稿审阅";
  if (selection.type === "material") return "材料查看";
  return "知识卡片";
}

export function sourceTypeColor(sourceType: string): string {
  const t = sourceType.toLowerCase();
  if (t.includes("capture") || t.includes("note")) return "bg-blue-500/15 text-blue-400";
  if (t.includes("garden") || t.includes("card")) return "bg-emerald-500/15 text-emerald-400";
  if (t.includes("theme")) return "bg-purple-500/15 text-purple-400";
  if (t.includes("url") || t.includes("link")) return "bg-gray-500/15 text-gray-400";
  return "bg-muted text-muted-foreground";
}

export function sourceTypeLabel(sourceType: string): string {
  const t = sourceType.toLowerCase();
  if (t.includes("capture")) return "知识文件";
  if (t.includes("garden") || t.includes("card")) return "garden";
  if (t.includes("theme")) return "theme";
  if (t.includes("learning")) return "note";
  if (t.includes("url") || t.includes("link")) return "url";
  return sourceType;
}

export function draftMetaRows(draft: KnowledgeCaptureDraft): Array<[string, string]> {
  return [
    ["状态", draft.status],
    ["用户意图", intentLabel(draft.user_intent)],
    ["来源类型", draft.source_type || "未记录"],
    ["来源", draft.source || "未记录"],
    ["创建时间", draft.created_at || "未记录"],
    ["更新时间", draft.updated_at || "未记录"],
    ["已入库知识文件", draft.committed_capture_id || "尚未入库"],
  ];
}
