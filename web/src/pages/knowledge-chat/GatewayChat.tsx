import React from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Compass,
  Copy,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  Paperclip,
  Radar,
  RefreshCw,
  Sparkles,
  SquareStop,
  X,
} from "lucide-react";
import { KnowledgeAnswerView, type KnowledgeAnswerSource } from "@/components/KnowledgeAnswerView";
import type { ConnectionState } from "@/lib/gatewayClient";
import { isKnowledgeSourceHint, type KnowledgeMessage, type KnowledgeSourceHint } from "@/lib/knowledgeChatState";
import type { KnowledgeResearchMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AnswerOutputType, ComposerAttachment } from "./shared";

const SCAN_TOPIC_PROMPT =
  "扫描最近保存的内容，看看有没有可以整理成知识卡片或输出选题的跨篇关联";

const PROMPT_STARTERS = [
  "基于知识库回答这个问题：",
  "展开最近的 Capture 草稿",
  SCAN_TOPIC_PROMPT,
];

type TopicKey = "all" | "interview" | "agent" | "industry";

const TOPIC_FILTERS: Array<{ key: TopicKey; label: string }> = [
  { key: "all", label: "全部专题" },
  { key: "interview", label: "🎯 AI 产品面试" },
  { key: "agent", label: "🤖 Agent 与大模型" },
  { key: "industry", label: "🌱 行业与产品拆解" },
];

const TOPIC_FALLBACK_PROMPT =
  "请结合我的知识卡片与知识库资料，帮我找出最近可以整理成专题输出的跨篇关联，并给出一个选题与输出提纲。";

interface TopicInspiration {
  key: Exclude<TopicKey, "all">;
  topicLabel: string;
  title: string;
  insight: string;
  prompt: string;
}

const TOPIC_INSPIRATIONS: TopicInspiration[] = [
  {
    key: "interview",
    topicLabel: "🎯 专题：AI 产品面试",
    title: "《如何向面试官证明你的 AI 功能不是“为了 AI 而 AI”的伪需求？》",
    insight:
      "串联《真伪需求判断三步法》方法卡与《高频输入切忌人工审批卡点》避坑卡，对比高频收集与低频决策的交互边界。",
    prompt:
      "请结合我知识库中关于“真伪需求判断”和“高频输入审批卡点”的卡片与资料，帮我梳理一份 AI 产品经理面试高分回答框架：《如何辨别并重构“为了 AI 而 AI”的伪需求？》",
  },
  {
    key: "agent",
    topicLabel: "🤖 专题：Agent 与大模型",
    title: "《破除多级 Agent 的“大模型传话筒效应”与 130 秒延迟优化复盘》",
    insight:
      "结合《大模型传话筒效应》新知卡、《130 秒延迟复盘》洞察卡与《MCP 工具收敛》资料，总结控制流与数据流分离的架构范式。",
    prompt:
      "请结合我知识库中关于“大模型传话筒效应”、“130秒重型研究管线复盘”和“Model Routing”的卡片与资料，生成一份结构化的项目亮点复盘手稿。",
  },
  {
    key: "industry",
    topicLabel: "🌱 专题：行业与产品拆解",
    title: "《为什么 90% 的个人知识库沦为“吃灰收藏夹”？从 RAG 证据分层谈破局》",
    insight:
      "对比 Notion AI、NotebookLM、腾讯 IMA 与本项目的“资料(Evidence) → 卡片(Viewpoint) → 专题(Topic)”三阶内化模型。",
    prompt:
      "请结合我知识库中的《PKM 竞品拆解》资料与《区分原文证据与个人观点》卡片，帮我撰写一篇关于个人知识库产品破局思路的深度分析提纲。",
  },
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
  interruptRequested,
  running,
  transcriptRef,
  uploading,
  onInputChange,
  onPickPrompt,
  onResearchModeChange,
  onRemoveAttachment,
  onSaveAnswer,
  onSourceOpen,
  onStop,
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
  interruptRequested: boolean;
  running: boolean;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  uploading: boolean;
  onInputChange: (value: string) => void;
  onPickPrompt: (value: string) => void;
  onResearchModeChange: (mode: KnowledgeResearchMode) => void;
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
            <TopicInspirationRadar
              collapsed
              onPick={onPickPrompt}
            />
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
          <ComposerQuickActions
            disabled={inputDisabled}
            mode={researchMode}
            onScan={() => onPickPrompt(SCAN_TOPIC_PROMPT)}
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
              onClick={running ? onStop : onSubmit}
              disabled={running ? interruptRequested : !canSend}
              className={cn(
                "flex h-16 w-12 shrink-0 items-center justify-center rounded-md border text-sm transition",
                running
                  ? interruptRequested
                    ? "border-border bg-muted/40 text-muted-foreground"
                    : "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15"
                  : canSend
                  ? "border-primary/50 bg-primary text-primary-foreground shadow-[0_14px_34px_-22px_rgba(47,111,95,0.65)] hover:brightness-105"
                  : "border-border bg-muted/40 text-muted-foreground",
              )}
              aria-label={submitLabel}
              title={submitLabel}
            >
              {running ? (
                interruptRequested ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SquareStop className="h-4 w-4" />
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
  mode: KnowledgeResearchMode;
  onChange: (mode: KnowledgeResearchMode) => void;
  onScan: () => void;
}) {
  const webEnabled = mode === "local_web" || mode === "web_only";
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(webEnabled ? "local_only" : "local_web")}
        aria-pressed={webEnabled}
        title={
          webEnabled
            ? "关闭联网搜索，仅检索个人知识库"
            : "开启 DeepSeek 联网搜索，与个人知识库联合解答"
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition",
          webEnabled
            ? "border-primary/50 bg-primary/15 font-medium text-primary"
            : "border-border bg-background/80 text-muted-foreground hover:border-primary/40 hover:text-foreground",
          disabled && "opacity-45",
        )}
      >
        🌐 联网搜索{webEnabled ? " · 已开启" : ""}
      </button>
      <span className="text-[11px] leading-5 text-muted-foreground">
        {webEnabled ? "⚡ DeepSeek 联网搜索 + 个人知识库联合解答" : "📚 默认检索个人知识库（卡片 + 资料）"}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onScan}
        className={cn(
          "ml-auto inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/8 px-2.5 py-1 text-xs font-medium text-primary transition hover:border-primary/50 hover:bg-primary/12",
          disabled && "opacity-45",
        )}
        title="让 Hermes 扫描最近保存的卡片与资料，找出可以整理成输出选题的跨篇关联"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        🔄 扫描跨篇新灵感
      </button>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex min-h-full items-start justify-center py-4">
      <div className="w-full max-w-5xl">
        <div className="rounded-xl border border-primary/20 bg-[linear-gradient(135deg,rgba(95,153,142,0.10),rgba(255,255,255,0)_60%)] p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
                <Radar className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-normal text-foreground">
                  ✨ 专题灵感雷达 & RAG 输出专区
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  先看跨篇灵感，再选一个选题进输出台：Hermes 会结合你的知识卡片与资料，合成一篇有出处的专题文稿。
                </p>
              </div>
            </div>
            <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary/80" />
              卡片 → 选题 → 输出
            </span>
          </div>

          <div className="mt-4">
            <TopicInspirationRadar onPick={onPick} />
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Compass className="h-3.5 w-3.5" />
            或者，直接开始
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
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
    </div>
  );
}

function TopicInspirationRadar({
  collapsed = false,
  onPick,
}: {
  collapsed?: boolean;
  onPick: (text: string) => void;
}) {
  const [topic, setTopic] = React.useState<TopicKey>("all");
  const visible = TOPIC_INSPIRATIONS.filter((item) => topic === "all" || item.key === topic);

  const body = (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Lightbulb className="h-3.5 w-3.5 text-primary/80" />
        💡 跨篇灵感与输出选题提案 (Topic Inspiration Cards)
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {TOPIC_FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTopic(item.key)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition",
              topic === item.key
                ? "border-primary/45 bg-primary/12 text-primary"
                : "border-border bg-background/60 text-muted-foreground hover:border-primary/30 hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onPick(SCAN_TOPIC_PROMPT)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-primary/10"
        >
          🔄 扫描跨篇新灵感
        </button>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {visible.length ? (
          visible.map((item) => (
            <TopicInspirationCard key={item.key} inspiration={item} onPick={onPick} />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-background/55 p-4 lg:col-span-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Lightbulb className="h-4 w-4 text-primary/80" />
              暂无预置选题，先扫描你的知识库
            </h3>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              让 Hermes 扫描最近保存的卡片与资料，自动找出可以整理成专题输出的跨篇关联。
            </p>
            <button
              type="button"
              onClick={() => onPick(TOPIC_FALLBACK_PROMPT)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-primary/35 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/55 hover:bg-primary/15"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary/80" />
              生成一个跨篇输出选题
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (!collapsed) return body;

  return (
    <details className="group rounded-lg border border-border bg-background/55 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Radar className="h-3.5 w-3.5 shrink-0 text-primary/80" />
          <span className="truncate">✨ 专题灵感雷达 · 3 个跨篇输出选题</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition group-open:rotate-180" />
      </summary>
      <div className="mt-3">{body}</div>
    </details>
  );
}

function TopicInspirationCard({
  inspiration,
  onPick,
}: {
  inspiration: TopicInspiration;
  onPick: (text: string) => void;
}) {
  return (
    <article className="flex flex-col rounded-lg border border-border bg-background/75 p-3.5 shadow-[0_12px_30px_-26px_rgba(24,40,35,0.4)] transition hover:border-primary/35">
      <div className="text-[0.7rem] font-medium text-primary">{inspiration.topicLabel}</div>
      <h3 className="mt-1.5 text-sm font-semibold leading-6 text-foreground">
        {inspiration.title}
      </h3>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        <span className="font-medium text-foreground/80">跨篇关联洞察：</span>
        {inspiration.insight}
      </p>
      <details className="mt-2 rounded border border-border/70 bg-background/60 px-2 py-1.5">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground">
          查看一键输出 Prompt
        </summary>
        <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{inspiration.prompt}</p>
      </details>
      <div className="mt-auto pt-3">
        <button
          type="button"
          onClick={() => onPick(inspiration.prompt)}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/55 hover:bg-primary/15"
        >
          <Sparkles className="h-3.5 w-3.5 text-primary/80" />
          ✍️ 选为输出主题，填入输出台
        </button>
      </div>
    </article>
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
