import { CheckCircle2, Loader2, NotebookPen, Save, Trash2, UploadCloud } from "lucide-react";
import type { KnowledgeCaptureDraft } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ActionButton, PanelEmpty, StatusBadge, TinyPill } from "./shared";

export type EditableCaptureStatus =
  | "empty"
  | "editing"
  | "saving_draft"
  | "ready_to_commit"
  | "committing"
  | "committed"
  | "error";

export function EditableCaptureWorkbench({
  content,
  draft,
  error,
  cardReason = "",
  cardSuggestionsText = "",
  folderSuggestionMode = "existing",
  folderSuggestionReason = "",
  folderOptions,
  folderPath,
  generateCard = false,
  source,
  status,
  summary = "",
  tagsText = "",
  title,
  onCardReasonChange,
  onCardSuggestionsTextChange,
  onCommit,
  onContentChange,
  onFolderChange,
  onFolderSuggestionModeChange,
  onFolderSuggestionReasonChange,
  onGenerateCardChange,
  onSaveDraft,
  onDeleteDraft,
  onSourceChange,
  onSummaryChange,
  onTagsTextChange,
  onTitleChange,
}: {
  content: string;
  draft: KnowledgeCaptureDraft | null;
  error: string;
  cardReason?: string;
  cardSuggestionsText?: string;
  folderSuggestionMode?: "existing" | "new";
  folderSuggestionReason?: string;
  folderOptions?: Array<{ path: string; name: string }>;
  folderPath?: string;
  generateCard?: boolean;
  source: string;
  status: EditableCaptureStatus;
  summary?: string;
  tagsText?: string;
  title: string;
  onCardReasonChange?: (value: string) => void;
  onCardSuggestionsTextChange?: (value: string) => void;
  onCommit: () => void;
  onContentChange: (value: string) => void;
  onFolderChange?: (value: string) => void;
  onFolderSuggestionModeChange?: (value: "existing" | "new") => void;
  onFolderSuggestionReasonChange?: (value: string) => void;
  onGenerateCardChange?: (value: boolean) => void;
  onSaveDraft: () => void;
  onDeleteDraft?: () => void;
  onSourceChange: (value: string) => void;
  onSummaryChange?: (value: string) => void;
  onTagsTextChange?: (value: string) => void;
  onTitleChange: (value: string) => void;
}) {
  const saving = status === "saving_draft";
  const committing = status === "committing";
  const locked = status === "committed";
  const canSave = Boolean(content.trim()) && !saving && !committing && !locked;
  const canCommit = Boolean(draft?.id) && !saving && !committing && status !== "committed";
  const canDeleteDraft = Boolean(draft?.id) && Boolean(onDeleteDraft) && !saving && !committing && !locked;
  const titleSource = String(draft?.capture_intent?.title_source || "ai");

  return (
    <>
      <div className="shrink-0 border-b border-border/80 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <TinyPill>自由编辑</TinyPill>
              {draft && <StatusBadge status={draft.status} />}
              {draft?.word_count ? <TinyPill>{draft.word_count} 字</TinyPill> : null}
            </div>
            <h2 className="mt-2 flex items-center gap-2 text-lg font-semibold tracking-normal text-foreground">
              <NotebookPen className="h-5 w-5 text-primary/80" />
              粘贴整理
            </h2>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={!canSave}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/35 bg-background/60 px-3 py-2 text-sm text-foreground transition hover:bg-primary/10 disabled:opacity-45"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              整理成草稿
            </button>
            {draft ? (
              <button
                type="button"
                onClick={onDeleteDraft}
                disabled={!canDeleteDraft}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-background/60 px-3 py-2 text-sm text-destructive transition hover:bg-destructive/10 disabled:opacity-45"
              >
                <Trash2 className="h-4 w-4" />
                删除草稿
              </button>
            ) : null}
            <ActionButton
              onClick={onCommit}
              disabled={!canCommit}
              loading={committing}
            >
              {status === "committed" ? "已入库" : "入库到知识库"}
            </ActionButton>
          </div>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex min-h-0 flex-col border-b border-border/80 lg:border-b-0 lg:border-r">
          <div className={cn(
            "grid gap-3 border-b border-border/80 bg-background/50 p-4",
            folderOptions?.length
              ? "2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(180px,0.72fr)]"
              : "2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
          )}>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                来源
              </span>
              <input
                value={source}
                onChange={(event) => onSourceChange(event.target.value)}
                disabled={locked || Boolean(draft)}
                placeholder="链接、公众号、小红书或手动记录"
                className="w-full rounded-md border border-border bg-background/80 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                标题
              </span>
              <input
                value={title}
                onChange={(event) => onTitleChange(event.target.value)}
                disabled={locked}
                placeholder={draft?.title || "可选，不填则 Hermes 自动生成"}
                className="w-full rounded-md border border-border bg-background/80 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              />
            </label>
            {folderOptions?.length ? (
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  所在文件夹
                </span>
                <select
                  value={folderPath || "Inbox"}
                  onChange={(event) => onFolderChange?.(event.target.value)}
                  disabled={locked}
                  className="w-full rounded-md border border-border bg-background/80 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                >
                  {folderOptions.map((folder) => (
                    <option key={folder.path} value={folder.path}>{folder.name}</option>
                  ))}
                  {folderPath && !folderOptions.some((folder) => folder.path === folderPath) ? (
                    <option value={folderPath}>{folderPath}</option>
                  ) : null}
                </select>
              </label>
            ) : null}
          </div>
          <textarea
            value={content}
            onChange={(event) => onContentChange(event.target.value)}
            disabled={locked}
            placeholder="粘贴或写下要入库到知识库的内容"
            className="min-h-[420px] flex-1 resize-none bg-background/72 p-4 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-70"
          />
        </section>

        <aside className="min-h-0 overflow-y-auto p-4">
          {draft ? (
            <div className="space-y-4">
              <section>
                <h3 className="text-sm font-semibold tracking-normal text-foreground">标题</h3>
                <input
                  value={title}
                  onChange={(event) => onTitleChange(event.target.value)}
                  disabled={locked}
                  className="mt-2 w-full rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/50 disabled:opacity-60"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {titleSource === "user" ? "用户标题" : "Hermes 自动生成"}
                </p>
              </section>
              <section>
                <h3 className="text-sm font-semibold tracking-normal text-foreground">摘要</h3>
                <textarea
                  value={summary}
                  onChange={(event) => onSummaryChange?.(event.target.value)}
                  disabled={locked}
                  className="mt-2 min-h-24 w-full resize-none rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/50 disabled:opacity-60"
                />
              </section>
              <section>
                <h3 className="text-sm font-semibold tracking-normal text-foreground">标签</h3>
                <input
                  value={tagsText}
                  onChange={(event) => onTagsTextChange?.(event.target.value)}
                  disabled={locked}
                  placeholder="用逗号分隔"
                  className="mt-2 w-full rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/50 disabled:opacity-60"
                />
              </section>
              <section>
                <h3 className="text-sm font-semibold tracking-normal text-foreground">文件夹建议</h3>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => onFolderSuggestionModeChange?.("existing")}
                    disabled={locked}
                    className={cn(
                      "rounded-md border px-2 py-1.5 text-xs transition disabled:opacity-60",
                      folderSuggestionMode === "existing"
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-current/10 bg-background/45 text-muted-foreground",
                    )}
                  >
                    放入已有文件夹
                  </button>
                  <button
                    type="button"
                    onClick={() => onFolderSuggestionModeChange?.("new")}
                    disabled={locked}
                    className={cn(
                      "rounded-md border px-2 py-1.5 text-xs transition disabled:opacity-60",
                      folderSuggestionMode === "new"
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-current/10 bg-background/45 text-muted-foreground",
                    )}
                  >
                    建议新建文件夹
                  </button>
                </div>
                <input
                  value={folderPath || "Inbox"}
                  onChange={(event) => onFolderChange?.(event.target.value)}
                  disabled={locked}
                  className="mt-2 w-full rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/50 disabled:opacity-60"
                />
                <textarea
                  value={folderSuggestionReason}
                  onChange={(event) => onFolderSuggestionReasonChange?.(event.target.value)}
                  disabled={locked}
                  placeholder="建议理由"
                  className="mt-2 min-h-20 w-full resize-none rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/50 disabled:opacity-60"
                />
              </section>
              <section>
                <label className="flex items-center justify-between gap-3 rounded-md border border-current/10 bg-background/45 px-3 py-2">
                  <span className="text-sm font-semibold tracking-normal text-foreground">入库后生成 Garden Card</span>
                  <input
                    type="checkbox"
                    checked={generateCard}
                    onChange={(event) => onGenerateCardChange?.(event.target.checked)}
                    disabled={locked}
                    className="h-4 w-4 accent-primary"
                  />
                </label>
                <textarea
                  value={cardReason}
                  onChange={(event) => onCardReasonChange?.(event.target.value)}
                  disabled={locked}
                  placeholder="卡片建议理由"
                  className="mt-2 min-h-20 w-full resize-none rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/50 disabled:opacity-60"
                />
                <textarea
                  value={cardSuggestionsText}
                  onChange={(event) => onCardSuggestionsTextChange?.(event.target.value)}
                  disabled={locked}
                  placeholder="建议生成哪些卡。每行一张：标题 | 类型 | 原因"
                  className="mt-2 min-h-24 w-full resize-none rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/50 disabled:opacity-60"
                />
              </section>
              <section>
                <h3 className="text-sm font-semibold tracking-normal text-foreground">状态</h3>
                <div className="mt-2 space-y-2">
                  {editableStatusSteps(status).map((step) => (
                    <div
                      key={step.label}
                      className={cn(
                        "flex items-center gap-2 rounded-md border border-current/10 bg-background/45 px-3 py-2 text-sm",
                        step.active ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {step.loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : step.done ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <UploadCloud className="h-4 w-4" />
                      )}
                      {step.label}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <PanelEmpty text="整理成草稿后会显示可修改的标题、摘要、标签、文件夹建议和卡片建议。" />
          )}
        </aside>
      </div>
    </>
  );
}

function editableStatusSteps(status: EditableCaptureStatus): Array<{ label: string; active?: boolean; done?: boolean; loading?: boolean }> {
  const saving = status === "saving_draft";
  const committing = status === "committing";
  const committed = status === "committed";
  return [
    { label: "草稿已保存", active: saving, done: status === "ready_to_commit" || committing || committed, loading: saving },
    { label: "标题和标签已生成", done: status === "ready_to_commit" || committing || committed },
    { label: "入库到知识库", active: committing, done: committed, loading: committing },
    { label: "可被 AI 检索", done: committed },
  ];
}
