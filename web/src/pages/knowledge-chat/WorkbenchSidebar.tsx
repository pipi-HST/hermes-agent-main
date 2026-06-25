import { Loader2, MessageSquareText, RefreshCw, Search } from "lucide-react";
import type { KnowledgeCaptureDraft, KnowledgeReadingDraft, SessionInfo } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import {
  DRAFT_FILTERS,
  type DraftFilterKey,
  type WorkbenchMode,
  LoadingBlock,
  PanelEmpty,
  StatusBadge,
  TinyPill,
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
  const listTitle = ({
    open: "待处理",
    all: "全部",
    committed: "已入库",
  } as Record<DraftFilterKey, string>)[filter];
  const showConversationHistory = currentMode === "chat" && filter === "open";
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
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="shrink-0 border-b border-border/80 p-3">
        <div className="mb-3 flex gap-2">
          <button
            type="button"
            onClick={() => onModeChange("chat")}
            className={cn(
              "min-w-0 flex-1 rounded-md border px-3 py-2 text-left transition",
              currentMode === "chat"
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-background/58 text-muted-foreground hover:text-foreground",
            )}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <MessageSquareText className="h-4 w-4" />
              当前对话
            </div>
            <p className="mt-1 truncate text-xs">{sessionId ? `Session ${sessionId}` : connectionLabel}</p>
          </button>
          <button
            type="button"
            onClick={onNewSession}
            disabled={Boolean(resumingSessionId)}
            className="shrink-0 rounded-md border border-border bg-background/58 px-3 text-sm text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-50"
          >
            新建
          </button>
        </div>

        <details
          className="mb-3 rounded-md border border-border bg-background/48 p-2"
          open={showConversationHistory ? true : undefined}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            对话历史
            {sessionsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </summary>
          <div className="mt-2">
            {sessions.length ? (
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {sessions.slice(0, 5).map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onResumeSession(session.id)}
                    disabled={Boolean(resumingSessionId)}
                    className="w-full rounded border border-transparent px-2 py-1.5 text-left transition hover:border-border hover:bg-background/70 disabled:opacity-50"
                  >
                    <span className="line-clamp-1 text-xs text-foreground">
                      {session.title || session.preview || session.id}
                    </span>
                    <span className="mt-0.5 block text-[0.68rem] text-muted-foreground">
                      {resumingSessionId === session.id ? "恢复中..." : `${timeAgo(session.last_active || session.started_at)} · ${session.message_count} 条`}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">暂无可恢复的历史对话。</p>
            )}
          </div>
        </details>

        <div className="flex gap-1 rounded-md border border-border bg-background/55 p-1">
          {DRAFT_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onFilterChange(item.key)}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-xs transition",
                filter === item.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="mt-3 flex items-center gap-2 rounded-md border border-border bg-background/70 px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索知识条目"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            知识条目 · {listTitle}
          </h2>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded p-1 text-muted-foreground hover:bg-background/70 hover:text-foreground"
            aria-label="刷新草稿"
            title="刷新草稿"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", knowledgeItemsLoading && "animate-spin")} />
          </button>
        </div>

        {knowledgeItemsLoading ? (
          <LoadingBlock text="读取知识条目..." />
        ) : knowledgeItems.length ? (
          <div className="space-y-2">
            {knowledgeItems.map((item) => item.kind === "answer" ? (
              <button
                key={`answer-${item.draft.id}`}
                type="button"
                onClick={() => onSelectAnswerDraft(item.draft.id)}
                className={cn(
                  "w-full rounded-md border p-3 text-left transition",
                  selectedAnswerDraftId === item.draft.id && currentMode === "answer_draft_review"
                    ? "border-primary/45 bg-primary/10"
                    : "border-border bg-background/58 hover:border-primary/25 hover:bg-background/82",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">
                    {item.draft.title || "未命名文稿"}
                  </h3>
                  <StatusBadge status={item.draft.status} />
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {item.draft.summary || item.draft.draft_preview || "暂无预览"}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <TinyPill>{answerDraftTypeLabel(item.draft.output_type)}</TinyPill>
                </div>
              </button>
            ) : (
              <button
                key={`capture-${item.draft.id}`}
                type="button"
                onClick={() => onSelectDraft(item.draft.id)}
                className={cn(
                  "w-full rounded-md border p-3 text-left transition",
                  selectedDraftId === item.draft.id && currentMode === "draft_review"
                    ? "border-primary/45 bg-primary/10"
                    : "border-border bg-background/58 hover:border-primary/25 hover:bg-background/82",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">
                    {item.draft.title || "未命名材料"}
                  </h3>
                  <StatusBadge status={item.draft.status} />
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {item.draft.summary || item.draft.draft_preview || item.draft.raw_preview || "暂无预览"}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <TinyPill>{intentLabel(item.draft.user_intent)}</TinyPill>
                  {item.draft.source_type && <TinyPill>{item.draft.source_type}</TinyPill>}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <PanelEmpty text="没有符合条件的知识条目。" />
        )}

      </div>
    </aside>
  );
}
