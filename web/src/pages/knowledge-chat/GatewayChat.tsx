import React from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Compass,
  Copy,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers3,
  Lightbulb,
  Loader2,
  Paperclip,
  RefreshCw,
  SquareStop,
  X,
} from "lucide-react";
import { KnowledgeAnswerView, type KnowledgeAnswerSource } from "@/components/KnowledgeAnswerView";
import type { ToolEntry } from "@/components/ToolCall";
import type { ConnectionState } from "@/lib/gatewayClient";
import { isKnowledgeSourceHint, type KnowledgeMessage, type KnowledgeSourceHint } from "@/lib/knowledgeChatState";
import type { KnowledgeChatResearchMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AnswerOutputType, ComposerAttachment } from "./shared";

const SCAN_TOPIC_PROMPT =
  "扫描最近保存的内容，看看有没有可以整理成知识卡片或输出选题的跨篇关联";

const PROMPT_STARTERS = [
  "结合我的知识卡片和资料库，帮我梳理一个专题框架：",
  "对比资料库里关于这个问题的不同观点：",
  SCAN_TOPIC_PROMPT,
];

export interface AttachedTopicCard {
  id: string;
  title: string;
  summary?: string;
  theme?: string;
}

export function GatewayChat({
  activeTurnTools = [],
  attachedCards = [],
  attachments,
  canSend,
  composerPlaceholder,
  connection,
  draftAssistant,
  fileInputRef,
  input,
  liveStatusText = "",
  liveThinking = "",
  messages,
  researchMode,
  interruptRequested,
  running,
  transcriptRef,
  turnStartedAt = null,
  uploading,
  onInputChange,
  onPickPrompt,
  onRemoveAttachedCard,
  onSubmitPrompt,
  onResearchModeChange,
  onRemoveAttachment,
  onSaveAnswer,
  onSourceOpen,
  onStop,
  onSubmit,
  onUploadFiles,
}: {
  activeTurnTools?: ToolEntry[];
  attachedCards?: AttachedTopicCard[];
  attachments: ComposerAttachment[];
  canSend: boolean;
  composerPlaceholder: string;
  connection: ConnectionState;
  draftAssistant: KnowledgeMessage | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  input: string;
  liveStatusText?: string;
  liveThinking?: string;
  messages: KnowledgeMessage[];
  researchMode: KnowledgeChatResearchMode;
  interruptRequested: boolean;
  running: boolean;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  turnStartedAt?: number | null;
  uploading: boolean;
  onInputChange: (value: string) => void;
  onPickPrompt: (value: string) => void;
  onRemoveAttachedCard?: (id: string) => void;
  onSubmitPrompt: (value: string) => void;
  onResearchModeChange: (mode: KnowledgeChatResearchMode) => void;
  onRemoveAttachment: (id: string) => void;
  onSaveAnswer: (message: KnowledgeMessage, outputType: AnswerOutputType) => void;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  onStop: () => void;
  onSubmit: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
}) {
  const inputDisabled = running || uploading || connection !== "open";
  const submitLabel = running
    ? interruptRequested
      ? "正在停止"
      : "停止生成"
    : "发送";
  const startThemeScan = (prompt: string = SCAN_TOPIC_PROMPT) => {
    onPickPrompt(prompt);
    onSubmitPrompt(prompt);
  };

  return (
    <>
      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-10"
      >
        {messages.length === 0 && !draftAssistant ? (
          <EmptyState onPick={onPickPrompt} onScan={startThemeScan} />
        ) : (
          <div className="mx-auto max-w-[780px] space-y-7">
            {messages.map((message) => (
              <TranscriptMessage
                key={message.id}
                message={message}
                onSaveAnswer={onSaveAnswer}
                onSourceOpen={onSourceOpen}
                sourceHints={message.sourceHints ?? []}
              />
            ))}
            {running && (
              <LiveWorkingCard
                hasVisibleAnswer={Boolean(draftAssistant?.text.trim())}
                interruptRequested={interruptRequested}
                liveStatusText={liveStatusText}
                liveThinking={liveThinking}
                researchMode={researchMode}
                tools={activeTurnTools}
                turnStartedAt={turnStartedAt}
              />
            )}
            {draftAssistant && draftAssistant.text.trim() && (
              <TranscriptMessage message={draftAssistant} onSourceOpen={onSourceOpen} streaming />
            )}
          </div>
        )}
      </div>

      <footer className="shrink-0 px-5 pb-5 pt-2 sm:px-10">
        <div
          className="mx-auto max-w-[780px] rounded-2xl border border-black/[0.1] bg-[#fafaf8] p-3 transition focus-within:border-foreground/30 focus-within:bg-white focus-within:shadow-[0_10px_30px_-18px_rgba(0,0,0,0.14)] dark:border-border dark:bg-background"
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            onUploadFiles(event.dataTransfer.files);
          }}
        >
          {attachedCards.length > 0 && (
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5 border-b border-border/55 pb-2.5">
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Layers3 className="h-3.5 w-3.5 text-foreground/70" />
                已带入卡片
              </span>
              {attachedCards.map((card) => (
                <span
                  key={card.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-2.5 py-0.5 text-xs text-foreground shadow-2xs dark:border-border dark:bg-card"
                >
                  <span className="max-w-[220px] truncate">{card.title}</span>
                  {onRemoveAttachedCard ? (
                    <button
                      type="button"
                      onClick={() => onRemoveAttachedCard(card.id)}
                      className="rounded p-0.5 text-muted-foreground transition hover:text-foreground"
                      aria-label={`移除卡片 ${card.title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => onRemoveAttachment(attachment.id)}
                />
              ))}
            </div>
          )}
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
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
            rows={2}
            placeholder={composerPlaceholder}
            className="min-h-[56px] max-h-44 w-full resize-none bg-transparent px-1.5 py-1 text-[14.5px] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={inputDisabled}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] bg-white text-muted-foreground transition hover:border-foreground/25 hover:text-foreground disabled:opacity-45 dark:border-border dark:bg-card"
                aria-label="上传文件"
                title="上传文件"
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Paperclip className="h-3.5 w-3.5" />
                )}
              </button>
              <ComposerQuickActions
                disabled={inputDisabled}
                mode={researchMode}
                onScan={() => startThemeScan()}
                onChange={onResearchModeChange}
              />
            </div>
            <button
              type="button"
              onClick={running ? onStop : () => onSubmit()}
              disabled={running ? interruptRequested : !canSend}
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition",
                running
                  ? interruptRequested
                    ? "bg-muted text-muted-foreground"
                    : "border border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15"
                  : canSend
                    ? "bg-foreground text-background hover:opacity-90"
                    : "bg-muted/70 text-muted-foreground/60",
              )}
              aria-label={submitLabel}
              title={submitLabel}
            >
              {running ? (
                interruptRequested ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SquareStop className="h-3.5 w-3.5" />
                )
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

function ComposerQuickActions({
  disabled,
  mode,
  onChange,
  onScan,
}: {
  disabled: boolean;
  mode: KnowledgeChatResearchMode;
  onChange: (mode: KnowledgeChatResearchMode) => void;
  onScan: () => void;
}) {
  const webEnabled = mode === "local_web";
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(webEnabled ? "local_only" : "local_web")}
        aria-pressed={webEnabled}
        title={
          webEnabled
            ? "关闭联网搜索，仅检索个人资料库"
            : "开启联网搜索，与个人资料库联合解答"
        }
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition",
          webEnabled
            ? "border-foreground bg-foreground font-medium text-background"
            : "border-black/[0.08] bg-white text-muted-foreground hover:border-foreground/25 hover:text-foreground dark:border-border dark:bg-card",
          disabled && "opacity-45",
        )}
      >
        <Globe className="h-3 w-3" />
        {webEnabled ? "联网 + 资料库" : "仅个人资料库"}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onScan}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-2.5 text-xs text-muted-foreground transition hover:border-foreground/25 hover:text-foreground dark:border-border dark:bg-card",
          disabled && "opacity-45",
        )}
        title="扫描最近保存的卡片与资料，发现跨篇输出选题"
      >
        <RefreshCw className="h-3 w-3" />
        扫描跨篇关联
      </button>
    </>
  );
}

function EmptyState({
  onPick,
  onScan,
}: {
  onPick: (text: string) => void;
  onScan: (prompt?: string) => void;
}) {
  return (
    <div className="flex min-h-full items-center justify-center py-10">
      <div className="w-full max-w-[680px]">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          开始一个新的专题研究
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          结合你的知识卡片、个人资料与联网证据，梳理结构、碰撞观点或直接成稿。
        </p>

        <div className="mt-7 grid gap-2.5 sm:grid-cols-3">
          {PROMPT_STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => (starter === SCAN_TOPIC_PROMPT ? onScan(starter) : onPick(starter))}
              className="rounded-xl border border-black/[0.08] bg-[#fafaf8] px-4 py-3.5 text-left text-[13px] leading-5 text-foreground/85 transition hover:border-foreground/25 hover:bg-white hover:text-foreground dark:border-border dark:bg-background"
            >
              {starter}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const TOPIC_ANSWER_PROSE_CLASSES =
  "[&_[data-markdown-root]]:space-y-4 [&_[data-markdown-root]]:text-[15px] [&_[data-markdown-root]]:leading-[1.85] [&_[data-markdown-root]]:text-foreground/90 " +
  "[&_[data-markdown-root]_h1]:pt-2 [&_[data-markdown-root]_h1]:text-lg [&_[data-markdown-root]_h1]:font-semibold [&_[data-markdown-root]_h1]:tracking-tight " +
  "[&_[data-markdown-root]_h2]:pt-2 [&_[data-markdown-root]_h2]:text-[16px] [&_[data-markdown-root]_h2]:font-semibold [&_[data-markdown-root]_h2]:tracking-tight " +
  "[&_[data-markdown-root]_h3]:pt-1.5 [&_[data-markdown-root]_h3]:text-[15px] [&_[data-markdown-root]_h3]:font-semibold " +
  "[&_[data-markdown-root]_ul]:space-y-2 [&_[data-markdown-root]_ul]:pl-5 [&_[data-markdown-root]_ul]:text-[15px] " +
  "[&_[data-markdown-root]_ol]:space-y-2 [&_[data-markdown-root]_ol]:pl-5 [&_[data-markdown-root]_ol]:text-[15px] " +
  "[&_[data-markdown-root]_li]:leading-[1.8] " +
  "[&_[data-markdown-root]_strong]:font-semibold [&_[data-markdown-root]_strong]:text-foreground " +
  "[&_[data-markdown-root]_blockquote]:rounded-xl [&_[data-markdown-root]_blockquote]:border-0 [&_[data-markdown-root]_blockquote]:bg-muted/45 [&_[data-markdown-root]_blockquote]:px-4 [&_[data-markdown-root]_blockquote]:py-3 [&_[data-markdown-root]_blockquote]:text-[14px] [&_[data-markdown-root]_blockquote]:leading-[1.75] [&_[data-markdown-root]_blockquote]:text-foreground/80";

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

  if (isUser) {
    return (
      <article className="flex justify-end">
        <div className="max-w-[min(640px,85%)] rounded-2xl bg-muted/70 px-4 py-2.5 text-[14.5px] leading-7 text-foreground">
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        </div>
      </article>
    );
  }

  return (
    <article className="min-w-0 border-b border-border/45 pb-6 last:border-b-0">
      {message.warning ? (
        <div className="mb-2 text-xs text-warning">{message.warning}</div>
      ) : null}

      {!streaming && message.reasoning ? (
        <details className="mb-3 rounded-xl bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium text-foreground/75">
            查看思考过程
          </summary>
          <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-border/40 pt-2 leading-5">
            {message.reasoning}
          </div>
        </details>
      ) : null}

      <div className={TOPIC_ANSWER_PROSE_CLASSES}>
        <KnowledgeAnswerView
          content={message.text}
          onSourceOpen={onSourceOpen}
          sources={answerSources}
          streaming={streaming}
          searchBackend={message.searchBackend}
        />
      </div>

      {!streaming && onSaveAnswer ? (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => void copyAnswer()}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 transition hover:bg-muted/70 hover:text-foreground"
            title="复制回答"
            aria-label="复制回答"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            onClick={() => onSaveAnswer(message, "local_learning_note")}
            className="inline-flex h-7 items-center rounded-md px-2 transition hover:bg-muted/70 hover:text-foreground"
          >
            存为笔记
          </button>
          <button
            type="button"
            onClick={() => onSaveAnswer(message, "knowledge_card")}
            className="inline-flex h-7 items-center rounded-md px-2 transition hover:bg-muted/70 hover:text-foreground"
          >
            做成卡片
          </button>
        </div>
      ) : null}
    </article>
  );
}

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  research_with_web: "检索资料库并联网搜索",
  search_my_notes: "检索个人资料库与知识卡片",
  continue_rag_answer: "展开更多资料细节",
  theme_scan: "扫描跨篇专题灵感",
  capture_content: "提取并整理输入材料",
  synthesize_garden: "提炼可复用知识卡片",
  start_reading_session: "建立伴读上下文",
  discuss_reading: "结合原文深度解惑",
  audit_library: "巡检资料库索引状态",
};

function toolActionLabel(name: string): string {
  return TOOL_DISPLAY_LABELS[name] ?? `执行工具：${name}`;
}

function formatDurationSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return `${mins}m ${rem}s`;
}

function LiveWorkingCard({
  hasVisibleAnswer,
  interruptRequested,
  liveStatusText,
  liveThinking,
  researchMode,
  tools,
  turnStartedAt,
}: {
  hasVisibleAnswer: boolean;
  interruptRequested: boolean;
  liveStatusText: string;
  liveThinking: string;
  researchMode: KnowledgeChatResearchMode;
  tools: ToolEntry[];
  turnStartedAt: number | null;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  const [userExpanded, setUserExpanded] = React.useState<boolean | null>(null);
  const thinkingBoxRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    if (thinkingBoxRef.current) {
      thinkingBoxRef.current.scrollTop = thinkingBoxRef.current.scrollHeight;
    }
  }, [liveThinking]);

  const elapsedSeconds = turnStartedAt ? Math.max(0, Math.floor((now - turnStartedAt) / 1000)) : 0;
  const runningTool = [...tools].reverse().find((tool) => tool.status === "running");
  const expanded = userExpanded ?? !hasVisibleAnswer;

  const headline = interruptRequested
    ? "正在停止生成..."
    : hasVisibleAnswer
      ? "正在输出回答"
      : runningTool
        ? toolActionLabel(runningTool.name)
        : liveThinking.trim()
          ? "正在深度思考与组织框架"
          : liveStatusText || (researchMode === "local_web" ? "正在规划资料库与联网检索" : "正在分析问题与检索资料");

  const waitHint = !hasVisibleAnswer && !liveThinking.trim() && elapsedSeconds >= 6
    ? runningTool?.name === "research_with_web"
      ? "正在并行检索本地资料库、抓取网页原文并综合推理，长材料通常需要 30–90 秒，请稍候…"
      : "正在处理较长上下文与综合推理，服务正常运行中…"
    : "";

  return (
    <article className="flex justify-start">
      <div className="w-full rounded-xl border border-black/[0.08] bg-[#fafaf8] px-4 py-2.5 text-xs dark:border-border dark:bg-muted/30">
        <button
          type="button"
          onClick={() => setUserExpanded(!expanded)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
            {hasVisibleAnswer ? (
              <span className="h-2 w-2 shrink-0 rounded-full bg-foreground/60 animate-pulse" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground/70" />
            )}
            <span className="truncate">{headline}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
            <span className="rounded-md bg-black/[0.05] px-2 py-0.5 font-mono text-[11px] text-foreground/75 dark:bg-background/70">
              {formatDurationSeconds(elapsedSeconds)}
            </span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
          </span>
        </button>

        {expanded ? (
          <div className="mt-2.5 space-y-2 border-t border-border/50 pt-2.5">
            {tools.length > 0 ? (
              <div className="space-y-1.5">
                {tools.map((tool) => {
                  const toolElapsed = tool.startedAt
                    ? Math.max(0, Math.floor(((tool.completedAt ?? now) - tool.startedAt) / 1000))
                    : 0;
                  const events = tool.progressEvents ?? [];
                  const visibleSteps = events.slice(-6);
                  const latestProgress = visibleSteps[visibleSteps.length - 1]?.preview || tool.preview;
                  return (
                    <div
                      key={tool.id}
                      className="rounded-md border border-border/60 bg-background/70 px-2.5 py-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground/90">
                          {tool.status === "running" ? (
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                          ) : (
                            <Check className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          )}
                          <span className="truncate">{toolActionLabel(tool.name)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {tool.status === "running"
                            ? `${formatDurationSeconds(toolElapsed)}`
                            : tool.error
                              ? "失败"
                              : `完成 · ${formatDurationSeconds(toolElapsed)}`}
                        </span>
                      </div>
                      {visibleSteps.length > 0 ? (
                        <ul className="mt-1.5 space-y-1 pl-4">
                          {visibleSteps.map((step, idx) => {
                            const isCurrent = tool.status === "running" && idx === visibleSteps.length - 1;
                            return (
                              <li
                                key={`${tool.id}-step-${idx}-${step.stage ?? step.preview}`}
                                className={cn(
                                  "flex items-center gap-1.5 text-[11px]",
                                  isCurrent ? "text-foreground/90" : "text-muted-foreground",
                                )}
                              >
                                {isCurrent ? (
                                  <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-primary" />
                                ) : (
                                  <Check className="h-2.5 w-2.5 shrink-0 text-emerald-600/80 dark:text-emerald-400/80" />
                                )}
                                <span className="truncate">{step.preview}</span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : latestProgress ? (
                        <p className="mt-1 truncate pl-4 text-[11px] text-muted-foreground">
                          {latestProgress}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Compass className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span>
                  {liveStatusText || (researchMode === "local_web"
                    ? "准备调用资料库与联网搜索工具…"
                    : "准备检索个人资料库与知识卡片…")}
                </span>
              </div>
            )}

            {liveThinking.trim() ? (
              <div className="rounded-md border border-border/60 bg-background/80 px-2.5 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Lightbulb className="h-3 w-3 text-amber-500" />
                  <span>实时思考过程</span>
                </div>
                <div
                  ref={thinkingBoxRef}
                  className="max-h-36 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground"
                >
                  {liveThinking}
                </div>
              </div>
            ) : null}

            {waitHint ? (
              <p className="text-[11px] leading-4 text-muted-foreground/90">
                {waitHint}
              </p>
            ) : null}
          </div>
        ) : null}
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
  if (normalized === "garden_card" || normalized === "knowledge_card") return "garden_card";
  return "";
}

function inferredOpenUrl(itemKind: string, itemId: string): string | undefined {
  if (!itemKind || !itemId) return undefined;
  if (itemKind === "garden_card" || itemKind === "knowledge_card") {
    return `/cards-board/${encodeURIComponent(itemId)}`;
  }
  return `/knowledge-library?kind=${encodeURIComponent(itemKind)}&item=${encodeURIComponent(itemId)}`;
}

function inferredRef(sourceType: string, index: number): string | undefined {
  const normalized = sourceType.toLowerCase();
  if (normalized === "web") return `W${index + 1}`;
  if (
    normalized === "knowledge" ||
    normalized === "garden_card" ||
    normalized === "knowledge_card" ||
    normalized.startsWith("capture")
  ) {
    return `${index + 1}`;
  }
  return undefined;
}
