import React from "react";
import {
  ArrowUp,
  Check,
  Copy,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Paperclip,
  X,
} from "lucide-react";
import { KnowledgeAnswerView, type KnowledgeAnswerSource } from "@/components/KnowledgeAnswerView";
import type { ConnectionState } from "@/lib/gatewayClient";
import { isKnowledgeSourceHint, type KnowledgeMessage, type KnowledgeSourceHint } from "@/lib/knowledgeChatState";
import type { KnowledgeResearchMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AnswerOutputType, ComposerAttachment } from "./shared";

const PROMPT_STARTERS = [
  "基于知识库回答这个问题：",
  "展开最近的 Capture 草稿",
  "扫描最近保存的内容，看看有没有可整理的关联",
];

export function GatewayChat({
  attachments,
  canSend,
  composerPlaceholder,
  connection,
  draftAssistant,
  fileInputRef,
  input,
  messages,
  researchMode,
  running,
  transcriptRef,
  uploading,
  onInputChange,
  onPickPrompt,
  onResearchModeChange,
  onRemoveAttachment,
  onSaveAnswer,
  onSourceOpen,
  onSubmit,
  onUploadFiles,
}: {
  attachments: ComposerAttachment[];
  canSend: boolean;
  composerPlaceholder: string;
  connection: ConnectionState;
  draftAssistant: KnowledgeMessage | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  input: string;
  messages: KnowledgeMessage[];
  researchMode: KnowledgeResearchMode;
  running: boolean;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  uploading: boolean;
  onInputChange: (value: string) => void;
  onPickPrompt: (value: string) => void;
  onResearchModeChange: (mode: KnowledgeResearchMode) => void;
  onRemoveAttachment: (id: string) => void;
  onSaveAnswer: (message: KnowledgeMessage, outputType: AnswerOutputType) => void;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  onSubmit: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
}) {
  const inputDisabled = running || uploading || connection !== "open";

  return (
    <>
      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {messages.length === 0 && !draftAssistant ? (
          <EmptyState onPick={onPickPrompt} />
        ) : (
          <div className="space-y-5">
            {messages.map((message) => (
              <TranscriptMessage
                key={message.id}
                message={message}
                onSaveAnswer={onSaveAnswer}
                onSourceOpen={onSourceOpen}
                sourceHints={message.sourceHints ?? []}
              />
            ))}
            {draftAssistant && (
              <TranscriptMessage message={draftAssistant} onSourceOpen={onSourceOpen} streaming />
            )}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border/80 bg-background/82 p-3">
        <div
          className="rounded-lg border border-border/80 bg-background/62 p-2"
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            onUploadFiles(event.dataTransfer.files);
          }}
        >
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => onRemoveAttachment(attachment.id)}
                />
              ))}
            </div>
          )}
          <ResearchModeControl
            disabled={inputDisabled}
            mode={researchMode}
            onChange={onResearchModeChange}
          />
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.currentTarget.files) {
                  onUploadFiles(event.currentTarget.files);
                }
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={inputDisabled}
              className={cn(
                "flex h-16 w-12 shrink-0 items-center justify-center rounded-md border text-sm transition",
                inputDisabled
                  ? "border-border bg-muted/40 text-muted-foreground"
                  : "border-border bg-background/80 text-foreground hover:border-primary/45 hover:bg-primary/10",
              )}
              aria-label="上传文件"
              title="上传文件"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </button>
            <textarea
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              placeholder={composerPlaceholder}
              className="min-h-16 flex-1 resize-none rounded-md border border-border bg-background/80 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSend}
              className={cn(
                "flex h-16 w-12 shrink-0 items-center justify-center rounded-md border text-sm transition",
                canSend
                  ? "border-primary/50 bg-primary text-primary-foreground shadow-[0_14px_34px_-22px_rgba(47,111,95,0.65)] hover:brightness-105"
                  : "border-border bg-muted/40 text-muted-foreground",
              )}
              aria-label="发送"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </footer>
    </>
  );
}

const RESEARCH_MODES: Array<{ label: string; mode: KnowledgeResearchMode }> = [
  { label: "仅知识库", mode: "local_only" },
  { label: "知识库+联网搜索", mode: "local_web" },
  { label: "联网搜索", mode: "web_only" },
];

function ResearchModeControl({
  disabled,
  mode,
  onChange,
}: {
  disabled: boolean;
  mode: KnowledgeResearchMode;
  onChange: (mode: KnowledgeResearchMode) => void;
}) {
  return (
    <div className="mb-2 inline-flex rounded-md border border-border bg-background/70 p-0.5">
      {RESEARCH_MODES.map((item) => (
        <button
          key={item.mode}
          type="button"
          disabled={disabled}
          onClick={() => onChange(item.mode)}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition",
            mode === item.mode
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
            disabled && "opacity-45",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex min-h-full items-center justify-center py-10">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
          <MessageSquareText className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold tracking-normal text-foreground">
          开始对话
        </h2>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {PROMPT_STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => onPick(starter)}
              className="rounded-md border border-current/10 bg-background/60 px-3 py-2 text-left text-sm leading-5 text-foreground transition hover:border-primary/40 hover:bg-primary/10"
            >
              {starter}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TranscriptMessage({
  message,
  onSaveAnswer,
  onSourceOpen,
  sourceHints = [],
  streaming,
}: {
  message: KnowledgeMessage;
  onSaveAnswer?: (message: KnowledgeMessage, outputType: AnswerOutputType) => void;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  sourceHints?: KnowledgeSourceHint[];
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = React.useState(false);
  const answerSources = React.useMemo(
    () => sourceHints.reduce<{ knowledge: KnowledgeAnswerSource[]; web: KnowledgeAnswerSource[] }>(
      (groups, source, index) => {
        const answerSource = answerSourceFromHint(source, index);
        if (isKnowledgeSourceHint(source)) {
          groups.knowledge.push(answerSource);
        } else {
          groups.web.push(answerSource);
        }
        return groups;
      },
      { knowledge: [], web: [] },
    ),
    [sourceHints],
  );

  const copyAnswer = React.useCallback(async () => {
    if (!message.text.trim()) return;
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [message.text]);

  return (
    <article className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0 rounded-lg border px-4 py-3 shadow-[0_10px_26px_-24px_rgba(24,40,35,0.32)]",
          isUser
            ? "max-w-[min(760px,85%)] border-primary/25 bg-primary/12"
            : "w-full border-border bg-background/72",
        )}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[0.68rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {isUser ? "You" : "Hermes"}
          </span>
          {message.warning ? (
            <span className="text-xs text-warning">{message.warning}</span>
          ) : null}
          {!streaming && !isUser && onSaveAnswer ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void copyAnswer()}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
                title="复制回答"
                aria-label="复制回答"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "已复制" : "复制"}
              </button>
              <button
                type="button"
                onClick={() => onSaveAnswer(message, "local_learning_note")}
                className="rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
              >
                存为笔记
              </button>
              <button
                type="button"
                onClick={() => onSaveAnswer(message, "knowledge_card")}
                className="rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
              >
                做成卡片
              </button>
            </div>
          ) : null}
        </div>

        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
            {message.text}
          </p>
        ) : (
          <KnowledgeAnswerView
            content={message.text}
            onSourceOpen={onSourceOpen}
            sources={answerSources}
            streaming={streaming}
          />
        )}
      </div>
    </article>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const Icon = attachment.kind === "image" ? ImageIcon : FileText;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-2 py-1 text-xs text-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0 text-primary/80" />
      <span className="min-w-0 truncate" title={attachment.mimeType || attachment.name}>
        {attachment.name}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {formatFileSize(attachment.size)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-background/70 hover:text-foreground"
        aria-label={`移除 ${attachment.name}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function answerSourceFromHint(source: KnowledgeSourceHint, index: number): KnowledgeAnswerSource {
  const isKnowledge = isKnowledgeSourceHint(source);
  const type = source.sourceType || (isKnowledge ? "knowledge" : "web");
  const itemKind = source.itemKind || inferredItemKind(type);
  const itemId = source.itemId || (itemKind ? source.sourceId || "" : "");
  return {
    ref: source.ref || inferredRef(type, index),
    type,
    id: source.sourceId || source.id,
    item_kind: itemKind || undefined,
    item_id: itemId || undefined,
    title: source.label,
    url: isKnowledge ? undefined : source.url,
    path: source.path || source.filePath,
    file_path: source.filePath,
    open_url: source.openUrl || inferredOpenUrl(itemKind, itemId),
    file_url: source.fileUrl,
    section: "",
    domain: source.domain,
  };
}

function inferredItemKind(sourceType: string): string {
  const normalized = sourceType.toLowerCase();
  if (normalized === "capture" || normalized === "capture_note" || normalized === "capture_section") return "capture";
  if (normalized === "capture_draft") return "capture_draft";
  return "";
}

function inferredOpenUrl(itemKind: string, itemId: string): string | undefined {
  return itemKind && itemId
    ? `/knowledge-library?kind=${encodeURIComponent(itemKind)}&item=${encodeURIComponent(itemId)}`
    : undefined;
}

function inferredRef(sourceType: string, index: number): string | undefined {
  const normalized = sourceType.toLowerCase();
  if (normalized === "web") return `W${index + 1}`;
  if (normalized === "knowledge" || normalized.startsWith("capture")) return `${index + 1}`;
  return undefined;
}
