import { type ReactNode, memo, useCallback, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  FileText,
  Globe,
  Layers3,
  Loader2,
  NotebookPen,
  PanelRightClose,
  RefreshCw,
  Search,
  SquareStop,
} from "lucide-react";
import type {
  KnowledgeLibraryItem,
  KnowledgeResearchMode,
  KnowledgeResearchSource,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { KnowledgeAnswerView } from "@/components/KnowledgeAnswerView";
import { EmptyState, LoadingState } from "@/pages/knowledge-library/shared";
import {
  ARTICLE_AI_STARTERS,
  type ArticleChatMessage,
  type ArticleResearchMode,
  articleAssistantRerunAction,
  directAnswerContextLabels,
  formatElapsedMs,
  hostLabel,
  numberField,
  numberOrZero,
  providerNumber,
  providerStatusLabels,
  queryStatusArray,
  queryStatusLabel,
  queryStatusTone,
  readSearchBackend,
  readableResearchWarnings,
  reasoningTraceDisplay,
  researchElapsedLabel,
  researchEvidenceRoleLabel,
  researchModeLabel,
  researchProgressFallback,
  researchSourceReasonLabel,
  researchStatusLabel,
  researchStatusTitle,
  researchSummaryText,
  sourceArray,
  stringArray,
  traceSourceCount,
  uniqueStrings,
} from "@/pages/knowledge-library/articleChatModel";

export function ArticleAIPanel({
  chatError,
  detail,
  loading,
  messages,
  researchMode,
  question,
  savingAnswerId,
  onAsk,
  onAskPrompt,
  onClose,
  onQuestionChange,
  onResearchModeChange,
  onRerun,
  onOpenSource,
  onOpenSourceLocal,
  onSaveAnswer,
  onStop,
}: {
  chatError: string;
  detail: KnowledgeLibraryItem;
  loading: boolean;
  messages: ArticleChatMessage[];
  researchMode: ArticleResearchMode;
  question: string;
  savingAnswerId: string;
  onAsk: () => void;
  onAskPrompt: (prompt: string) => void;
  onClose: () => void;
  onQuestionChange: (value: string) => void;
  onResearchModeChange: (mode: ArticleResearchMode) => void;
  onRerun: (message: ArticleChatMessage, mode: KnowledgeResearchMode, forceWeb?: boolean) => void;
  onOpenSource: (source: KnowledgeResearchSource) => void;
  onOpenSourceLocal: (source: KnowledgeResearchSource) => void;
  onSaveAnswer: (message: ArticleChatMessage, outputType: "local_learning_note" | "knowledge_card") => void;
  onStop: () => void;
}) {
  const hasPendingAssistant = messages.some((message) => message.role === "assistant" && message.pending);
  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-black/[0.07] bg-white/95 dark:border-border/70 dark:bg-card xl:flex">
      <div className="shrink-0 border-b border-border/55 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-[13.5px] font-semibold tracking-tight text-foreground" title={detail.title || "未命名文件"}>
            伴读助手
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
              title="收起伴读"
              aria-label="收起伴读面板"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <ResearchModeControl
          disabled={loading}
          mode={researchMode}
          onChange={onResearchModeChange}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length ? (
          <div className="space-y-5">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  message.role === "user"
                    ? "ml-6 rounded-2xl bg-muted/65 px-3.5 py-2.5 text-[13.5px] leading-6 text-foreground"
                    : "text-[14px] leading-[1.8] text-foreground/90",
                )}
              >
                {message.role === "assistant" ? (
                  <ArticleAssistantAnswer
                    content={message.content}
                    message={message}
                    onOpenSource={onOpenSource}
                    onOpenSourceLocal={onOpenSourceLocal}
                    onRerun={onRerun}
                    saving={savingAnswerId === message.id}
                    onSave={onSaveAnswer}
                  />
                ) : (
                  <>
                    <div className="whitespace-pre-wrap break-words">{message.content}</div>
                    {message.selectionPreview ? (
                      <div className="mt-1.5 truncate border-t border-black/[0.06] pt-1.5 text-[11.5px] text-muted-foreground">
                        摘录：{message.selectionPreview}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ))}
            {loading && !hasPendingAssistant ? (
              <LoadingState text="正在整理回答..." />
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <EmptyState text="划选正文中的一段话，或直接提问；会结合当前资料与个人资料库为你解惑。" />
            <div className="flex flex-wrap gap-1.5">
              {ARTICLE_AI_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  disabled={loading}
                  onClick={() => onAskPrompt(starter.prompt)}
                  className="rounded-lg border border-black/[0.08] bg-[#fafaf8] px-2.5 py-1.5 text-xs text-foreground/80 transition hover:border-foreground/25 hover:bg-white hover:text-foreground disabled:opacity-45 dark:border-border dark:bg-background"
                >
                  {starter.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/55 p-3">
        {chatError ? (
          <div className="mb-2 rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-xs text-destructive">
            {chatError}
          </div>
        ) : null}
        <div className="rounded-xl border border-black/[0.1] bg-[#fafaf8] p-2 transition focus-within:border-foreground/30 focus-within:bg-white dark:border-border dark:bg-background">
          <textarea
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              if (!loading && question.trim()) onAsk();
            }}
            className="h-20 w-full resize-none bg-transparent px-1.5 py-1 text-[13.5px] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="对当前内容提问，或划选一段文字..."
          />
          <div className="mt-1 flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground/80">Enter 发送</span>
            <button
              type="button"
              onClick={loading ? onStop : onAsk}
              disabled={loading ? false : !question.trim()}
              aria-label={loading ? "停止" : "发送"}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-lg transition disabled:opacity-35",
                loading
                  ? "border border-destructive/35 bg-destructive/10 text-destructive"
                  : "bg-foreground text-background hover:opacity-90",
              )}
            >
              {loading ? <SquareStop className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function ResearchModeControl({
  disabled,
  mode,
  onChange,
}: {
  disabled: boolean;
  mode: ArticleResearchMode;
  onChange: (mode: ArticleResearchMode) => void;
}) {
  const webEnabled = mode === "local_web";
  return (
    <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={webEnabled}
        onClick={() => onChange(webEnabled ? "current_article_only" : "local_web")}
        title={
          webEnabled
            ? "关闭联网搜索，仅使用当前资料与个人资料库"
            : "开启联网搜索，与个人资料库联合解答"
        }
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition",
          webEnabled
            ? "border-foreground bg-foreground font-medium text-background"
            : "border-border/80 bg-[#fafaf8] text-muted-foreground hover:border-foreground/25 hover:text-foreground dark:bg-background",
          disabled && "opacity-45",
        )}
      >
        <Globe className="h-3 w-3" />
        联网搜索{webEnabled ? " · 开" : ""}
      </button>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
        {webEnabled ? "联网 + 个人资料库" : "当前资料 + 资料库"}
      </span>
    </div>
  );
}

export function ArticleAssistantAnswer({
  content,
  message,
  onOpenSource,
  onOpenSourceLocal,
  onRerun,
  saving,
  onSave,
}: {
  content: string;
  message: ArticleChatMessage;
  onOpenSource: (source: KnowledgeResearchSource) => void;
  onOpenSourceLocal: (source: KnowledgeResearchSource) => void;
  onRerun: (message: ArticleChatMessage, mode: KnowledgeResearchMode, forceWeb?: boolean) => void;
  saving: boolean;
  onSave: (message: ArticleChatMessage, outputType: "local_learning_note" | "knowledge_card") => void;
}) {
  const [copied, setCopied] = useState(false);
  const streamingAnswer = Boolean(message.pending && message.researchTrace?.answer_streaming && content.trim());
  const showPendingPlaceholder = Boolean(
    message.pending && !streamingAnswer && !message.researchTrace?.web_search_attempted,
  );
  const rerunAction = articleAssistantRerunAction(message);

  const copyAnswer = useCallback(async () => {
    if (!content.trim()) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [content]);

  return (
    <div className="min-w-0">
      <div className="[&_a]:break-words [&_pre]:max-w-full">
        <ArticleResearchProcess message={message} />
        <ArticleReasoningTrace message={message} />
        {showPendingPlaceholder ? (
          <div className="text-sm leading-6 text-muted-foreground">正在整理回答...</div>
        ) : message.pending && !streamingAnswer ? null : (
          <KnowledgeAnswerView
            content={content}
            onSourceOpen={(source) => onOpenSource(source as KnowledgeResearchSource)}
            onSourceOpenLocal={(source) => onOpenSourceLocal(source as KnowledgeResearchSource)}
            sources={message.sources}
            streaming={message.pending}
            searchBackend={readSearchBackend(
              message.researchTrace,
              message.responseMeta?.provider_status,
              message.responseMeta,
            )}
          />
        )}
      </div>
      {!message.pending ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => void copyAnswer()}
            className="inline-flex items-center gap-1 transition hover:text-foreground"
            title="复制回答"
            aria-label="复制回答"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            onClick={() => onSave(message, "local_learning_note")}
            disabled={saving}
            className="inline-flex items-center gap-1 transition hover:text-foreground disabled:opacity-45"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <NotebookPen className="h-3.5 w-3.5" />}
            存笔记
          </button>
          <button
            type="button"
            onClick={() => onSave(message, "knowledge_card")}
            disabled={saving}
            className="inline-flex items-center gap-1 transition hover:text-foreground disabled:opacity-45"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers3 className="h-3.5 w-3.5" />}
            做卡片
          </button>
          {rerunAction ? (
            <button
              type="button"
              onClick={() => onRerun(message, rerunAction.mode, rerunAction.forceWeb)}
              className="inline-flex items-center gap-1 transition hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {rerunAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ArticleReasoningTrace({ message }: { message: ArticleChatMessage }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const trace = message.responseMeta?.reasoning_trace;
  if (!trace || message.pending) return null;
  const display = reasoningTraceDisplay(trace);
  if (!display.trim()) return null;

  const copyTrace = async () => {
    await navigator.clipboard.writeText(display);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="mb-2 rounded-md border border-border/70 bg-muted/20 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left transition hover:text-foreground"
      >
        <span>{trace.source === "api" ? "过程" : "过程摘要"}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="border-t border-border/60 px-2 py-1.5">
          {trace.source !== "api" && trace.fallback_reason ? (
            <div className="mb-1 text-[11px] text-muted-foreground">{trace.fallback_reason}</div>
          ) : null}
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-2 font-mono text-[11px] leading-5 text-foreground/85">
            {display}
          </pre>
          <button
            type="button"
            onClick={() => void copyTrace()}
            className="mt-1 inline-flex items-center gap-1 transition hover:text-foreground"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制过程"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export const ArticleResearchProcess = memo(function ArticleResearchProcess({ message }: { message: ArticleChatMessage }) {
  const trace = message.researchTrace;
  const meta = message.responseMeta;
  const providerStatusRecord = trace?.provider_status ?? meta?.provider_status;
  const webQueries = uniqueStrings([
    ...stringArray(trace?.rewritten_web_queries),
    ...stringArray(trace?.rewritten_queries),
    ...stringArray(trace?.web_queries),
    ...stringArray(trace?.queries),
    ...stringArray(meta?.rewritten_web_queries),
    ...stringArray(meta?.web_queries),
  ]);
  const queryStatuses = queryStatusArray(trace?.query_statuses || providerStatusRecord?.query_statuses);
  const providerStatus = providerStatusLabels(providerStatusRecord);
  const currentStage =
    typeof trace?.provider_status === "object" && trace.provider_status && "stage" in trace.provider_status
      ? String((trace.provider_status as Record<string, unknown>).stage || "")
      : "";
  const status = typeof trace?.plan_status === "string" ? trace.plan_status : "";
  const webSearchAttempted = Boolean(trace?.web_search_attempted ?? meta?.web_search_attempted);
  const knowledgeCount = message.sources?.knowledge?.length ?? traceSourceCount(trace?.knowledge_sources);
  const webStatus = researchProgressFallback({
    mode: message.mode,
    pending: Boolean(message.pending),
    webSearchAttempted,
    knowledgeCount,
  });
  const evidenceSources = message.sources?.web?.length
    ? message.sources.web
    : sourceArray(trace?.evidence_sources).length
      ? sourceArray(trace?.evidence_sources)
      : sourceArray(trace?.web_sources);
  const candidateSources = sourceArray(trace?.candidate_sources).length
    ? sourceArray(trace?.candidate_sources)
    : sourceArray(trace?.retrieved_web_sources);
  const clueSources = sourceArray(trace?.clue_sources);
  const rejectedSources = sourceArray(trace?.rejected_sources);
  const webCount = evidenceSources.length;
  const queryCount = numberField(trace?.query_count) || webQueries.length;
  const candidateCount =
    numberField(trace?.candidate_count) ||
    numberField(trace?.source_counts?.candidate) ||
    candidateSources.length;
  const readCount =
    numberField(trace?.opened_pages) ||
    providerNumber(providerStatusRecord, "opened_pages") ||
    providerNumber(providerStatusRecord, "extracted_pages") ||
    numberField(trace?.extracted_pages);
  const elapsedLabel = researchElapsedLabel(trace, meta);
  const displayWarnings = readableResearchWarnings(message.warnings || [], queryStatuses, providerStatusRecord);
  const isDirectMode = message.mode === "current_article_only";
  const directContextRows = isDirectMode ? directAnswerContextLabels(trace, meta, elapsedLabel) : [];
  const summaryText = researchSummaryText({
    candidateCount,
    mode: message.mode,
    pending: Boolean(message.pending),
    queryCount,
    readCount,
    sourceCount: webCount || knowledgeCount,
    elapsedLabel,
    webSearchAttempted,
  });
  const shouldRender = Boolean(
    message.mode ||
      status ||
      webQueries.length ||
      providerStatus.length ||
      directContextRows.length ||
      webSearchAttempted ||
      knowledgeCount ||
      webCount ||
      candidateSources.length ||
      clueSources.length ||
      rejectedSources.length ||
      displayWarnings.length,
  );
  if (!shouldRender) return null;

  return (
    <div className="mb-2 border-b border-border/50 pb-2 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        {message.pending ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/70" />
        ) : isDirectMode ? (
          <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 truncate font-medium text-foreground">{summaryText}</div>
      </div>
      {message.pending && (currentStage || researchStatusLabel(status) || webStatus) ? (
        <div className="mt-0.5 truncate pl-5 text-[0.72rem] text-muted-foreground">
          {currentStage || researchStatusLabel(status) || webStatus}
        </div>
      ) : null}
      <ResearchAuditDetails
        candidateSources={isDirectMode ? [] : candidateSources}
        clueSources={isDirectMode ? [] : clueSources}
        contextRows={directContextRows}
        detailsLabel={isDirectMode ? "回答详情" : "检索详情"}
        providerStatus={isDirectMode ? [] : providerStatus}
        queryStatuses={isDirectMode ? [] : queryStatuses}
        queries={isDirectMode ? [] : webQueries}
        rejectedSources={isDirectMode ? [] : rejectedSources}
        progress={
          <ResearchProgress
            currentStage={currentStage}
            mode={message.mode}
            status={status}
            webStatus={webStatus}
          />
        }
        statusTitle={researchStatusTitle(message.mode, webSearchAttempted)}
        warnings={displayWarnings}
      />
    </div>
  );
});

export function ResearchProgress({
  currentStage,
  mode,
  status,
  webStatus,
}: {
  currentStage: string;
  mode?: KnowledgeResearchMode;
  status: string;
  webStatus: string;
}) {
  const currentText = currentStage || researchStatusLabel(status) || webStatus;
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 text-[0.72rem]">
      <div className="min-w-0 truncate">
        <span className="text-muted-foreground">当前：</span>
        <span className="text-foreground">{currentText}</span>
      </div>
      <div className="shrink-0 text-muted-foreground">
        {mode ? researchModeLabel(mode) : ""}
      </div>
    </div>
  );
}

export const ResearchSourceGroup = memo(function ResearchSourceGroup({
  title,
  sources,
  showReason = false,
}: {
  title: string;
  sources: KnowledgeResearchSource[];
  showReason?: boolean;
}) {
  if (!sources.length) return null;
  return (
    <div className="mt-2 space-y-1">
      <div className="font-medium text-foreground">{title}</div>
      <div className="space-y-1">
        {sources.slice(0, 5).map((source, index) => (
          <div
            key={source.url || source.ref || `${source.title}-${index}`}
            className="truncate rounded border border-border bg-background/70 px-1.5 py-0.5"
          >
            <span className="text-foreground">
              {source.ref ? `[${source.ref}] ` : ""}
              {source.title || source.url || "未命名网页"}
            </span>
            {source.url ? <span className="ml-1 text-muted-foreground">{hostLabel(source.url)}</span> : null}
            {source.search_backend ? <span className="ml-1 text-muted-foreground">{source.search_backend}</span> : null}
            {source.evidence_role ? (
              <span className="ml-1 text-muted-foreground">{researchEvidenceRoleLabel(source.evidence_role)}</span>
            ) : null}
            {showReason && source.quality_reason ? (
              <span className="ml-1 text-muted-foreground">{researchSourceReasonLabel(source.quality_reason)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
});

export function ResearchAuditDetails({
  candidateSources,
  clueSources,
  contextRows,
  detailsLabel,
  providerStatus,
  progress,
  queryStatuses,
  queries,
  rejectedSources,
  statusTitle,
  warnings,
}: {
  candidateSources: KnowledgeResearchSource[];
  clueSources: KnowledgeResearchSource[];
  contextRows?: string[];
  detailsLabel: string;
  providerStatus: string[];
  progress: ReactNode;
  queryStatuses: Array<Record<string, unknown>>;
  queries: string[];
  rejectedSources: KnowledgeResearchSource[];
  statusTitle: string;
  warnings: string[];
}) {
  const hasDetails = Boolean(contextRows?.length) || queries.length || queryStatuses.length || candidateSources.length || clueSources.length || rejectedSources.length || providerStatus.length || warnings.length;
  if (!hasDetails) return null;
  return (
    <details className="mt-1.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[0.72rem] text-muted-foreground transition hover:text-foreground">
        {detailsLabel}
        <ChevronDown className="h-3 w-3" />
      </summary>
      <div className="mt-2 border-t border-border/50 pt-2">
        {progress}
        {contextRows?.length ? (
          <div className="mt-2 space-y-1">
            <div className="font-medium text-foreground">上下文</div>
            <div className="space-y-1">
              {contextRows.map((row) => (
                <div key={row} className="truncate rounded border border-border bg-background/70 px-1.5 py-0.5">
                  {row}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {queryStatuses.length ? (
          <div className="mt-2 space-y-1">
            <div className="font-medium text-foreground">查询词</div>
            <div className="space-y-1">
              {queryStatuses.map((status, index) => (
                <div key={`${String(status.query || "")}-${index}`} className="rounded border border-border bg-background/70 px-1.5 py-0.5">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[0.68rem] text-foreground">
                      {String(status.query || "未命名查询")}
                    </span>
                    <span className={cn("shrink-0 text-[0.68rem]", queryStatusTone(status.status))}>
                      {queryStatusLabel(status.status)}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[0.68rem] text-muted-foreground">
                    {status.status === "skipped"
                      ? "未执行"
                      : `结果 ${numberOrZero(status.result_count)} · 耗时 ${formatElapsedMs(numberOrZero(status.duration_ms))}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : queries.length ? (
          <div className="mt-2 space-y-1">
            <div className="font-medium text-foreground">查询词</div>
            <div className="space-y-1">
              {queries.map((query) => (
                <div key={query} className="truncate rounded border border-border bg-background/70 px-1.5 py-0.5 font-mono text-[0.68rem]">
                  {query}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <ResearchSourceGroup title="候选网页" sources={candidateSources} />
        <ResearchSourceGroup title="候选线索" sources={clueSources} showReason />
        <ResearchSourceGroup title="未采用" sources={rejectedSources} showReason />
        {providerStatus.length ? (
          <div className="mt-2 space-y-1">
            <div className="font-medium text-foreground">{statusTitle}</div>
            <div className="space-y-1">
              {providerStatus.map((statusText) => (
                <div key={statusText} className="truncate rounded border border-border bg-background/70 px-1.5 py-0.5">
                  {statusText}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {warnings.length ? (
          <div className="mt-2 space-y-1 text-warning">
            {warnings.map((warning) => (
              <div key={warning} className="flex items-start gap-1.5">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
