import { ArrowRight, Loader2, Send, Sparkles, Trash2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import type { KnowledgeReadingDraft } from "@/lib/api";
import {
  type AnswerDraftActionLoading,
  ActionButton,
  LoadingBlock,
  PanelEmpty,
  StatusBadge,
  readingDraftCaptureId,
} from "./shared";

export function ReadingDraftReview({
  actionLoading,
  detail,
  loading,
  revision,
  onCommit,
  onCreateCard,
  onDelete,
  onRevise,
  onRevisionChange,
}: {
  actionLoading: AnswerDraftActionLoading;
  detail: KnowledgeReadingDraft | null;
  loading: boolean;
  revision: string;
  onCommit: () => void;
  onCreateCard: () => void;
  onDelete: () => void;
  onRevise: () => void;
  onRevisionChange: (value: string) => void;
}) {
  if (loading) return <LoadingBlock text="读取回答沉淀草稿..." />;
  if (!detail) return <PanelEmpty text="请选择一条 Hermes 回答，生成可审阅的知识草稿。" />;

  const isCommitted = detail.status === "committed";
  const typeLabel = isCommitted
    ? ({
        local_learning_note: "学习笔记",
        knowledge_card: "知识卡片",
        enhance_capture: "主笔记增强",
      } as Record<string, string>)[detail.output_type] ?? "回答沉淀"
    : ({
        local_learning_note: "学习笔记草稿",
        knowledge_card: "知识卡片草稿",
        enhance_capture: "主笔记增强草稿",
      } as Record<string, string>)[detail.output_type] ?? "回答沉淀草稿";
  const canCommit = detail.status === "open";
  const canCreateCard =
    detail.output_type === "local_learning_note"
    && detail.status === "committed"
    && Boolean(readingDraftCaptureId(detail));

  return (
    <>
      <div className="shrink-0 border-b border-border/80 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {typeLabel}
              </span>
              <StatusBadge status={detail.status} />
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
              {detail.title || "未命名草稿"}
            </h2>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {!isCommitted && (
              <>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={!canCommit || Boolean(actionLoading)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-destructive/35 bg-background/60 px-3 py-2 text-sm text-destructive transition hover:bg-destructive/10 disabled:border-border disabled:text-muted-foreground disabled:opacity-50"
                >
                  {actionLoading === "delete" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  删除草稿
                </button>
                <ActionButton
                  onClick={onCommit}
                  disabled={!canCommit || Boolean(actionLoading)}
                  loading={actionLoading === "commit"}
                >
                  确认保存
                </ActionButton>
              </>
            )}
            {canCreateCard && (
              <button
                type="button"
                onClick={onCreateCard}
                disabled={Boolean(actionLoading)}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-background/60 px-3 py-2 text-sm text-foreground transition hover:bg-primary/10 disabled:opacity-45"
              >
                {actionLoading === "card" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                转知识卡片
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {detail.draft_text || detail.draft_preview ? (
          <Markdown content={detail.draft_text || detail.draft_preview} />
        ) : (
          <PanelEmpty text="这份回答沉淀草稿还没有正文。" />
        )}
      </div>

      {!isCommitted && (
      <div className="shrink-0 border-t border-border/80 bg-background/82 p-3">
        <div className="flex flex-col gap-2 lg:flex-row">
          <textarea
            value={revision}
            onChange={(event) => onRevisionChange(event.target.value)}
            placeholder="写修改意见，比如：删掉重复段落、把第二部分展开、改成更像正式文稿..."
            className="min-h-20 flex-1 resize-none rounded-md border border-border bg-background/80 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="button"
            onClick={onRevise}
            disabled={!revision.trim() || detail.status !== "open" || Boolean(actionLoading)}
            className="inline-flex min-h-20 items-center justify-center gap-2 rounded-md border border-primary/45 bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[0_14px_34px_-22px_rgba(47,111,95,0.65)] transition hover:brightness-105 disabled:border-border disabled:bg-muted/40 disabled:text-muted-foreground"
          >
            {actionLoading === "revise" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            继续修改
          </button>
        </div>
      </div>
      )}
    </>
  );
}
