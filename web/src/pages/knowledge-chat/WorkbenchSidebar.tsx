import { Loader2, MessageSquareText, Plus, RefreshCw, Search } from "lucide-react";
import type { KnowledgeCaptureDraft, KnowledgeReadingDraft, SessionInfo } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import {
  DRAFT_FILTERS,
  type DraftFilterKey,
  type WorkbenchMode,
  LoadingBlock,
  PanelEmpty,
  StatusBadge,
  answerDraftTypeLabel,
  intentLabel,
} from "./shared";

type KnowledgeListItem =
  | { kind: "answer"; draft: KnowledgeReadingDraft; updatedAt: string }
  | { kind: "capture"; draft: KnowledgeCaptureDraft; updatedAt: string };

export function WorkbenchSidebar({
  answerDrafts,
  answerDraftsLoading,
  connectionLabel,
  currentMode,
  drafts,
  filter,
  loading,
  query,
  resumingSessionId,
  selectedAnswerDraftId,
  sessions,
  sessionsLoading,
  selectedDraftId,
  sessionId,
  onFilterChange,
  onModeChange,
  onNewSession,
  onQueryChange,
  onRefresh,
  onSelectAnswerDraft,
  onResumeSession,
  onSelectDraft,
}: {
  answerDrafts: KnowledgeReadingDraft[];
  answerDraftsLoading: boolean;
  connectionLabel: string;
  currentMode: WorkbenchMode;
  drafts: KnowledgeCaptureDraft[];
  filter: DraftFilterKey;
  loading: boolean;
  query: string;
  resumingSessionId: string;
  selectedAnswerDraftId: string;
  sessions: SessionInfo[];
  sessionsLoading: boolean;
  selectedDraftId: string;
  sessionId: string | null;
  onFilterChange: (filter: DraftFilterKey) => void;
  onModeChange: (mode: WorkbenchMode) => void;
  onNewSession: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelectAnswerDraft: (draftId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onSelectDraft: (draftId: string) => void;
}) {
  const knowledgeItems: KnowledgeListItem[] = [
    ...answerDrafts.map((draft) => ({
      kind: "answer" as const,
      draft,
      updatedAt: draft.updated_at || draft.created_at || "",
    })),
    ...drafts.map((draft) => ({
      kind: "capture" as const,
      draft,
      updatedAt: draft.updated_at || draft.created_at || "",
    })),
  ].sort((a, b) => Date.parse(b.updatedAt || "0") - Date.parse(a.updatedAt || "0"));
  const knowledgeItemsLoading = loading || answerDraftsLoading;

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-black/[0.07] bg-[#f7f7f4]/80 dark:border-border/70 dark:bg-card/60">
      <div className="shrink-0 border-b border-border/55 p-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onModeChange("chat")}
            className={cn(
              "inline-flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition",
              currentMode === "chat"
                ? "bg-white font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.06] dark:bg-card"
                : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground",
            )}
          >
            <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">当前对话</span>
            {!sessionId && (
              <span className="ml-auto shrink-0 text-[11px] font-normal text-muted-foreground">
                {connectionLabel}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onNewSession}
            disabled={Boolean(resumingSessionId)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-foreground px-2.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            title="新建专题对话"
          >
            <Plus className="h-3.5 w-3.5" />
            新建
          </button>
        </div>

        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-muted-foreground/85">最近对话</span>
            {sessionsLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
          {sessions.length ? (
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {sessions.slice(0, 8).map((session) => {
                const isCurrent = sessionId === session.id && currentMode === "chat";
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onResumeSession(session.id)}
                    disabled={Boolean(resumingSessionId)}
                    className={cn(
                      "w-full rounded-lg px-2.5 py-1.5 text-left transition disabled:opacity-50",
                      isCurrent
                        ? "bg-white text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.06] dark:bg-card"
                        : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground",
                    )}
                  >
                    <span className="line-clamp-1 text-xs font-medium text-foreground">
                      {session.title || session.preview || "未命名对话"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground/85">
                      {resumingSessionId === session.id
                        ? "恢复中..."
                        : `${timeAgo(session.last_active || session.started_at)} · ${session.message_count} 条`}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">暂无历史对话。</p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-b border-border/55 px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium text-muted-foreground">专题成稿</h2>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md p-1 text-muted-foreground hover:bg-black/[0.05] hover:text-foreground"
            aria-label="刷新成稿"
            title="刷新成稿"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", knowledgeItemsLoading && "animate-spin")} />
          </button>
        </div>

        <div className="flex gap-1 rounded-lg bg-black/[0.045] p-0.5 dark:bg-muted/50">
          {DRAFT_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onFilterChange(item.key)}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs transition",
                filter === item.key
                  ? "bg-white font-medium text-foreground shadow-2xs dark:bg-card"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="mt-2 flex h-8 items-center gap-2 rounded-lg border border-black/[0.08] bg-white px-2.5 focus-within:border-foreground/30 dark:border-border dark:bg-background">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索专题成稿..."
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {knowledgeItemsLoading ? (
          <LoadingBlock text="读取专题成稿..." />
        ) : knowledgeItems.length ? (
          <div className="space-y-1.5">
            {knowledgeItems.map((item) => item.kind === "answer" ? (
              <button
                key={`answer-${item.draft.id}`}
                type="button"
                onClick={() => onSelectAnswerDraft(item.draft.id)}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left transition",
                  selectedAnswerDraftId === item.draft.id && currentMode === "answer_draft_review"
                    ? "border-black/[0.12] bg-white shadow-2xs dark:border-border dark:bg-card"
                    : "border-transparent bg-white/55 hover:border-black/[0.08] hover:bg-white dark:bg-card/40",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-xs font-medium leading-5 text-foreground">
                    {item.draft.title || "未命名文稿"}
                  </h3>
                  <StatusBadge status={item.draft.status} />
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {item.draft.summary || item.draft.draft_preview || "暂无预览"}
                </p>
                <div className="mt-1.5 text-[11px] text-muted-foreground/80">
                  {answerDraftTypeLabel(item.draft.output_type)}
                </div>
              </button>
            ) : (
              <button
                key={`capture-${item.draft.id}`}
                type="button"
                onClick={() => onSelectDraft(item.draft.id)}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left transition",
                  selectedDraftId === item.draft.id && currentMode === "draft_review"
                    ? "border-black/[0.12] bg-white shadow-2xs dark:border-border dark:bg-card"
                    : "border-transparent bg-white/55 hover:border-black/[0.08] hover:bg-white dark:bg-card/40",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-xs font-medium leading-5 text-foreground">
                    {item.draft.title || "未命名材料"}
                  </h3>
                  <StatusBadge status={item.draft.status} />
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {item.draft.summary || item.draft.draft_preview || item.draft.raw_preview || "暂无预览"}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground/80">
                  <span>{intentLabel(item.draft.user_intent)}</span>
                  {item.draft.source_type && <span>· {item.draft.source_type}</span>}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <PanelEmpty text="暂无专题成稿。将满意的回答点「存为笔记」后会沉淀到这里。" />
        )}
      </div>
    </aside>
  );
}
