import { ArrowRight, Edit3, Loader2, Send, Sparkles, SquareStop, Trash2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import type { KnowledgeCaptureDraft } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  OPEN_STATUSES,
  type DraftView,
  ActionButton,
  InfoGrid,
  LoadingBlock,
  PanelEmpty,
  StatusBadge,
  TinyPill,
  draftMetaRows,
  intentLabel,
} from "./shared";

export function DraftReview({
  actionLoading,
  detail,
  detailLoading,
  revision,
  view,
  onCommit,
  onDelete,
  onEditCommittedCapture,
  onOpenCardFlow,
  onRevise,
  onRevisionChange,
  onStopAiOperation,
  stoppingAiOperation,
  onViewChange,
}: {
  actionLoading: "commit" | "revise" | "card" | "delete" | null;
  detail: KnowledgeCaptureDraft | null;
  detailLoading: boolean;
  revision: string;
  view: DraftView;
  onCommit: () => void;
  onDelete: () => void;
  onEditCommittedCapture: () => void;
  onOpenCardFlow: () => void;
  onRevise: () => void;
  onRevisionChange: (value: string) => void;
  onStopAiOperation?: () => void;
  stoppingAiOperation?: boolean;
  onViewChange: (view: DraftView) => void;
}) {
  if (detailLoading) return <LoadingBlock text="读取草稿详情..." />;
  if (!detail) return <PanelEmpty text="请选择一个草稿，或先在聊天里提交材料生成草稿。" />;
  return (
    <DraftReviewLoaded
      actionLoading={actionLoading}
      detail={detail}
      revision={revision}
      view={view}
      onCommit={onCommit}
      onDelete={onDelete}
      onEditCommittedCapture={onEditCommittedCapture}
      onOpenCardFlow={onOpenCardFlow}
      onRevise={onRevise}
      onRevisionChange={onRevisionChange}
      onStopAiOperation={onStopAiOperation}
      stoppingAiOperation={stoppingAiOperation}
      onViewChange={onViewChange}
    />
  );
}

function DraftReviewLoaded({
  actionLoading,
  detail,
  revision,
  view,
  onCommit,
  onDelete,
  onEditCommittedCapture,
  onOpenCardFlow,
  onRevise,
  onRevisionChange,
  onStopAiOperation,
  stoppingAiOperation,
  onViewChange,
}: {
  actionLoading: "commit" | "revise" | "card" | "delete" | null;
  detail: KnowledgeCaptureDraft;
  revision: string;
  view: DraftView;
  onCommit: () => void;
  onDelete: () => void;
  onEditCommittedCapture: () => void;
  onOpenCardFlow: () => void;
  onRevise: () => void;
  onRevisionChange: (value: string) => void;
  onStopAiOperation?: () => void;
  stoppingAiOperation?: boolean;
  onViewChange: (view: DraftView) => void;
}) {
  const isOpenDraft = OPEN_STATUSES.has(detail.status);
  const isCommitted = detail.status === "committed" && Boolean(detail.committed_capture_id);
  const canCreateCard = detail.status === "committed" && Boolean(detail.committed_capture_id?.trim());
  const hasFinalDraft = Boolean(detail.draft_text?.trim());
  const needsFinalization = detail.status === "raw_extracted" && !hasFinalDraft;
  const isFullTextIntent =
    detail.user_intent === "verbatim_full_text" ||
    (Array.isArray(detail.capture_intent.output_shape) &&
      detail.capture_intent.output_shape.includes("full_text"));
  const commitLabel = needsFinalization
    ? isFullTextIntent
      ? "全文高保真保存"
      : "整理并保存"
    : isFullTextIntent
      ? "生成整理稿并保存"
      : "确认保存";
  const canStop = Boolean(onStopAiOperation) && ["commit", "revise", "card"].includes(actionLoading || "");

  return (
    <>
      <div className="shrink-0 border-b border-border/80 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              <TinyPill>{intentLabel(detail.user_intent)}</TinyPill>
              {detail.word_count > 0 && <TinyPill>{detail.word_count} 字</TinyPill>}
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
              {detail.title || "未命名草稿"}
            </h2>
            {detail.instruction && (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                用户要求：{detail.instruction}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {!isCommitted && (
              <>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={!isOpenDraft || Boolean(actionLoading)}
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
                  disabled={!isOpenDraft || Boolean(actionLoading)}
                  loading={actionLoading === "commit"}
                >
                  {actionLoading === "commit" && needsFinalization ? "正在整理..." : commitLabel}
                </ActionButton>
              </>
            )}
            {canStop ? (
              <button
                type="button"
                onClick={onStopAiOperation}
                disabled={stoppingAiOperation}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/35 bg-background/60 px-3 py-2 text-sm text-destructive transition hover:bg-destructive/10 disabled:opacity-45"
              >
                {stoppingAiOperation ? <Loader2 className="h-4 w-4 animate-spin" /> : <SquareStop className="h-4 w-4" />}
                {stoppingAiOperation ? "正在停止" : "停止"}
              </button>
            ) : null}
            {isCommitted && (
              <button
                type="button"
                onClick={onEditCommittedCapture}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-3 py-2 text-sm text-foreground transition hover:bg-primary/10"
              >
                <Edit3 className="h-4 w-4" />
                去资料库编辑
              </button>
            )}
            <button
              type="button"
              onClick={onOpenCardFlow}
              disabled={!canCreateCard || Boolean(actionLoading)}
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
          </div>
        </div>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-border/80 bg-background/50 px-4 py-2">
        {[
          ["draft", isCommitted ? "笔记" : "整理稿"],
          ["raw", "原文"],
          ["meta", isCommitted ? "信息" : "元信息"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onViewChange(key as DraftView)}
            className={cn(
              "rounded px-3 py-1.5 text-sm transition",
              view === key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isCommitted && (
          <div className="mb-3 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-sm leading-6 text-success">
            这份材料已保存。需要调整内容时，请进入资料库编辑页。
          </div>
        )}
        {needsFinalization && (
          <div className="mb-3 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-sm leading-6 text-foreground">
            原文已提取，正在等待确认。确认后再生成高保真 Markdown 正文并保存。
          </div>
        )}
        {view === "draft" && (
          hasFinalDraft ? (
            <Markdown content={detail.draft_text || ""} enableKnowledgeOutlineLinks />
          ) : (
            <PanelEmpty text="原文已提取，尚未生成最终整理稿。" />
          )
        )}
        {view === "raw" && (
          detail.raw_text ? (
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-background/62 p-4 text-sm leading-7 text-foreground">
              {detail.raw_text}
            </pre>
          ) : (
            <PanelEmpty text="没有保存原文内容。" />
          )
        )}
        {view === "meta" && <DraftMeta draft={detail} />}
      </div>

      {!isCommitted && (
        <div className="shrink-0 border-t border-border/80 bg-background/82 p-3">
          <div className="flex flex-col gap-2 lg:flex-row">
            <textarea
              value={revision}
              onChange={(event) => onRevisionChange(event.target.value)}
              placeholder="写修改意见，比如：把第二部分展开，保留更多原文例子，删掉模板化表达..."
              className="min-h-20 flex-1 resize-none rounded-md border border-border bg-background/80 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
          <button
            type="button"
            onClick={onRevise}
              disabled={!revision.trim() || !isOpenDraft || Boolean(actionLoading)}
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

function DraftMeta({ draft }: { draft: KnowledgeCaptureDraft }) {
  return (
    <div className="space-y-4">
      <InfoGrid
        rows={draftMetaRows(draft)}
      />
      {draft.tags.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold tracking-normal text-foreground">标签</h3>
          <div className="flex flex-wrap gap-2">
            {draft.tags.map((tag) => (
              <TinyPill key={tag}>{tag}</TinyPill>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold tracking-normal text-foreground">
          Capture Intent
        </h3>
        <pre className="overflow-x-auto rounded-md border border-current/10 bg-background/50 p-3 text-xs leading-5 text-muted-foreground">
          {JSON.stringify(draft.capture_intent, null, 2)}
        </pre>
      </section>
    </div>
  );
}
