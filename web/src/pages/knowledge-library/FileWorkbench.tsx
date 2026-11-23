import {
  type ComponentType,
  useState,
} from "react";
import {
  ExternalLink,
  Eye,
  Layers3,
  Loader2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Save,
  Send,
  SquareStop,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  KnowledgeLibraryFolder,
  KnowledgeLibraryItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/pages/knowledge-library/shared";
import { type ArticleSelectionContext } from "@/pages/knowledge-library/selection";
import { ReadonlyMarkdownDocument } from "@/pages/knowledge-library/ReadingOverlay";

export type LibraryWorkbenchMode = "browse" | "edit";

export function FileWorkbench({
  body,
  canGenerateCard,
  canPublish,
  cardGenerating,
  committing,
  deleting,
  detail,
  folder,
  folders,
  mode,
  saving,
  title,
  aiPanelOpen,
  onAiPanelToggle,
  onBodyChange,
  onDelete,
  onFolderChange,
  onGenerateCard,
  onOpenLocal,
  onPermanentDelete,
  onModeChange,
  onPublish,
  onSave,
  onStopAiOperation,
  onSelectionContextChange,
  stoppingAiOperation,
  onTitleChange,
}: {
  body: string;
  canGenerateCard: boolean;
  canPublish: boolean;
  cardGenerating: boolean;
  committing: boolean;
  deleting: boolean;
  detail: KnowledgeLibraryItem;
  folder: string;
  folders: KnowledgeLibraryFolder[];
  mode: LibraryWorkbenchMode;
  saving: boolean;
  title: string;
  aiPanelOpen: boolean;
  onAiPanelToggle: () => void;
  onBodyChange: (value: string) => void;
  onDelete: () => void;
  onFolderChange: (value: string) => void;
  onGenerateCard: () => void;
  onOpenLocal: () => void;
  onPermanentDelete: () => void;
  onModeChange: (mode: LibraryWorkbenchMode) => void;
  onPublish: () => void;
  onSave: () => void;
  onStopAiOperation?: () => void;
  onSelectionContextChange: (context: ArticleSelectionContext | null) => void;
  stoppingAiOperation?: boolean;
  onTitleChange: (value: string) => void;
}) {
  const isPublished = detail.kind === "capture";
  const canOpenLocal = isPublished && Boolean(detail.file_path);
  const canPermanentDelete = isPublished;
  const [moreOpen, setMoreOpen] = useState(false);
  const busy = deleting || saving || committing || cardGenerating;
  const canStop = Boolean(onStopAiOperation) && (committing || cardGenerating);
  return (
    <>
      <div className="relative shrink-0 border-b border-border/55 px-6 py-4 sm:px-9">
        <div className="mx-auto max-w-[740px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge item={detail} />
              <span>·</span>
              <span>{detail.word_count || body.length} 字</span>
              {detail.garden_card_count > 0 ? (
                <>
                  <span>·</span>
                  <span>{detail.garden_card_count} 张卡片</span>
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              {isPublished ? (
                <button
                  type="button"
                  onClick={onGenerateCard}
                  disabled={!canGenerateCard || cardGenerating}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-45"
                  title="从当前资料提炼一张知识卡片草稿"
                >
                  {cardGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers3 className="h-3.5 w-3.5" />}
                  {cardGenerating ? "提炼中..." : "提炼卡片"}
                </button>
              ) : null}
              <div className="inline-flex h-8 rounded-lg bg-muted/60 p-0.5">
                <ModeButton active={mode === "browse"} icon={Eye} label="阅读" onClick={() => onModeChange("browse")} />
                <ModeButton active={mode === "edit"} icon={Pencil} label="编辑" onClick={() => onModeChange("edit")} />
              </div>
              {mode === "browse" ? (
                <button
                  type="button"
                  onClick={onAiPanelToggle}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition",
                    aiPanelOpen
                      ? "border-foreground/20 bg-muted/60 font-medium text-foreground"
                      : "border-border/80 bg-white text-muted-foreground hover:border-foreground/25 hover:text-foreground dark:bg-card",
                  )}
                  title={aiPanelOpen ? "收起伴读" : "展开伴读"}
                >
                  {aiPanelOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
                  伴读
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setMoreOpen((current) => !current)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/80 bg-white text-muted-foreground transition hover:border-foreground/25 hover:text-foreground dark:bg-card"
                title="更多操作"
                aria-label="更多"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {canStop ? (
                <button
                  type="button"
                  onClick={onStopAiOperation}
                  disabled={stoppingAiOperation}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/35 bg-white px-2.5 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-45"
                  title={stoppingAiOperation ? "正在停止" : "停止"}
                >
                  {stoppingAiOperation ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SquareStop className="h-3.5 w-3.5" />}
                  {stoppingAiOperation ? "正在停止" : "停止"}
                </button>
              ) : null}
            </div>
          </div>
          {moreOpen ? (
            <div className="absolute right-6 top-14 z-20 w-52 rounded-xl border border-black/[0.08] bg-white p-1 shadow-lg dark:border-border dark:bg-popover">
              {canOpenLocal ? (
                <MenuButton icon={ExternalLink} label="用本地 App 打开" onClick={() => { setMoreOpen(false); onOpenLocal(); }} />
              ) : null}
              {!isPublished ? (
                <MenuButton
                  icon={Send}
                  label={committing ? "正在保存" : "保存到资料库"}
                  disabled={!canPublish}
                  onClick={() => { setMoreOpen(false); onPublish(); }}
                />
              ) : null}
              <MenuButton
                icon={Trash2}
                label={isPublished ? "归档" : "删除"}
                tone="danger"
                disabled={busy}
                onClick={() => { setMoreOpen(false); onDelete(); }}
              />
              {canPermanentDelete ? (
                <MenuButton
                  icon={XCircle}
                  label="彻底删除"
                  tone="danger"
                  disabled={busy}
                  onClick={() => { setMoreOpen(false); onPermanentDelete(); }}
                />
              ) : null}
            </div>
          ) : null}
          {mode === "edit" ? (
            <input
              value={title}
              disabled={busy}
              onChange={(event) => onTitleChange(event.target.value)}
              className="mt-3.5 w-full rounded-lg border border-transparent bg-transparent px-0 py-1 text-2xl font-semibold tracking-tight outline-none transition focus:border-border focus:bg-muted/30 focus:px-3"
              placeholder="文件标题"
            />
          ) : (
            <h2 className="mt-3.5 break-words text-[22px] font-semibold leading-snug tracking-tight text-foreground sm:text-2xl">
              {title || "未命名文件"}
            </h2>
          )}
          {mode === "edit" ? (
            <div className="mt-3 max-w-md">
              <label className="flex items-center gap-2 rounded-lg border border-border/80 bg-background/60 px-3 py-1.5 text-xs">
                <span className="shrink-0 text-muted-foreground">所属目录</span>
                <select
                  value={folder}
                  disabled={busy}
                  onChange={(event) => onFolderChange(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
                >
                  {folders.map((folderItem) => (
                    <option key={folderItem.path} value={folderItem.path}>{folderItem.name}</option>
                  ))}
                  {!folders.some((folderItem) => folderItem.path === folder) ? (
                    <option value={folder}>{folder}</option>
                  ) : null}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-hidden", mode === "edit" ? "px-6 py-4 sm:px-9" : "")}>
        {mode === "browse" ? (
          <ReadonlyMarkdownDocument
            body={body}
            onSelectionContextChange={onSelectionContextChange}
          />
        ) : (
          <div className="mx-auto h-full max-w-[740px]">
            <textarea
              value={body}
              disabled={busy}
              onChange={(event) => onBodyChange(event.target.value)}
              className="h-full min-h-[360px] w-full resize-none rounded-xl border border-border/80 bg-background/50 px-4 py-3.5 text-[15px] leading-[1.8] outline-none focus:border-foreground/30"
              placeholder="开始记录..."
            />
          </div>
        )}
      </div>

      {(mode === "edit" || !isPublished) ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-white/95 px-6 py-3 dark:bg-card">
          {mode === "edit" ? (
            <button
              type="button"
              onClick={onSave}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {isPublished ? "保存文件" : "保存草稿"}
            </button>
          ) : null}
          {!isPublished ? (
            <button
              type="button"
              onClick={onPublish}
              disabled={!canPublish}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-foreground/25 bg-muted/40 px-3.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-45"
            >
              {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              保存到资料库
            </button>
          ) : null}
          {canStop ? (
            <button
              type="button"
              onClick={onStopAiOperation}
              disabled={stoppingAiOperation}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/35 bg-white px-3 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-45"
            >
              {stoppingAiOperation ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SquareStop className="h-3.5 w-3.5" />}
              {stoppingAiOperation ? "正在停止" : "停止"}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function MenuButton({
  disabled = false,
  icon: Icon,
  label,
  tone = "default",
  onClick,
}: {
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition disabled:opacity-45",
        tone === "danger"
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground hover:bg-background/80",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-foreground">{value}</div>
    </div>
  );
}

export function ModeButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 text-xs transition",
        active
          ? "bg-white font-medium text-foreground shadow-2xs dark:bg-card"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
