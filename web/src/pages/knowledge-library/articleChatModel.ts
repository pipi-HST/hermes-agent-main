import type {
  KnowledgeChatHistoryMessage,
  KnowledgeLibraryItem,
  KnowledgeLibrarySelectionChatResponse,
  KnowledgeLibrarySelectionChatStreamEvent,
  KnowledgeResearchMode,
  KnowledgeResearchSource,
  KnowledgeResearchTrace,
} from "@/lib/api";

export interface ArticleAiRequestContext {
  question: string;
  selected_text: string;
  surrounding_before: string;
  surrounding_after: string;
  heading_path: string[];
  selection_start?: number;
  selection_end?: number;
  selection_confidence: "offset" | "text_only" | "none";
  mode: KnowledgeResearchMode;
  history?: KnowledgeChatHistoryMessage[];
  history_summary?: string;
  history_summary_version?: number;
  history_overflow?: KnowledgeChatHistoryMessage[];
  force_web?: boolean;
}

export function readSearchBackend(...statuses: unknown[]): string | undefined {
  for (const status of statuses) {
    if (!status || typeof status !== "object") continue;
    const record = status as Record<string, unknown>;
    const value = record.search_backend;
    if (typeof value === "string" && value.trim()) return value.trim();
    const provider = record.provider_status;
    if (provider && typeof provider === "object") {
      const nested = (provider as Record<string, unknown>).search_backend;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return undefined;
}


export interface ArticleChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  selectionPreview?: string;
  createdAt: string;
  pending?: boolean;
  mode?: KnowledgeResearchMode;
  sources?: {
    knowledge?: KnowledgeResearchSource[];
    web?: KnowledgeResearchSource[];
  };
  researchTrace?: KnowledgeResearchTrace;
  responseMeta?: KnowledgeLibrarySelectionChatResponse["meta"];
  warnings?: string[];
  requestContext?: ArticleAiRequestContext;
  compressedIntoSummaryVersion?: number;
}

export type ArticleChatMessagesByMode = Record<"current_article_only" | "local_web", ArticleChatMessage[]>;

/** Modes the article companion exposes; `web_only` only appears in history. */
export type ArticleResearchMode = "current_article_only" | "local_web";

export const EMPTY_ARTICLE_CHAT_MESSAGES: ArticleChatMessagesByMode = {
  current_article_only: [],
  local_web: [],
};

export function articleChatModeKey(mode: KnowledgeResearchMode): keyof ArticleChatMessagesByMode {
  return mode === "local_web" ? "local_web" : "current_article_only";
}

export const ARTICLE_AI_STARTERS: Array<{ label: string; prompt: string }> = [
  { label: "总结核心结论", prompt: "请用三句话总结这篇资料的核心结论，并指出它回答了什么真问题。" },
  { label: "讲懂不懂的段落", prompt: "请用通俗的语言讲懂这篇资料里最难理解的概念，并举一个实际例子。" },
  { label: "提炼 3 张卡片", prompt: "请把这篇资料提炼成 3 张可复用的知识卡片，每张都说明适用场景与边界。" },
];

export function articleSourcesForSave(
  sources: ArticleChatMessage["sources"],
  detail: KnowledgeLibraryItem,
) {
  const articleSource = {
    type: detail.kind === "capture" ? "capture_note" : "capture_draft",
    id: detail.id,
    title: detail.title,
    label: "当前文章",
    excerpt: detail.summary || detail.preview || "",
  };
  const knowledgeSources = (sources?.knowledge ?? []).map((source) => ({
    type: "knowledge",
    id: source.id || "",
    title: source.title || "",
    label: source.ref || "",
    excerpt: source.excerpt || source.section || "",
    url: source.url || "",
  }));
  const webSources = (sources?.web ?? []).map((source) => ({
    type: "web",
    id: source.id || source.url || "",
    title: source.title || "",
    label: source.ref || "",
    excerpt: source.excerpt || source.description || "",
    url: source.url || "",
  }));
  return [articleSource, ...knowledgeSources, ...webSources];
}

export function selectionChatHistory(messages: ArticleChatMessage[]): KnowledgeChatHistoryMessage[] {
  return successfulArticleChatPairs(messages)
    .slice(-6)
    .flatMap(([user, assistant]) => [
      { role: "user" as const, content: articleHistoryUserContent(user) },
      { role: "assistant" as const, content: assistant.content },
    ]);
}

export function selectionChatHistoryOverflow(messagesByMode: ArticleChatMessagesByMode): KnowledgeChatHistoryMessage[] {
  const overflow: KnowledgeChatHistoryMessage[] = [];
  for (const messages of Object.values(messagesByMode)) {
    const pairs = successfulArticleChatPairs(messages);
    const compactablePairs = pairs
      .slice(0, Math.max(0, pairs.length - 6))
      .filter(([user, assistant]) => !user.compressedIntoSummaryVersion && !assistant.compressedIntoSummaryVersion);
    for (const [user, assistant] of compactablePairs) {
      overflow.push(
        { role: "user", content: articleHistoryUserContent(user) },
        { role: "assistant", content: assistant.content },
      );
    }
  }
  return overflow;
}

export function successfulArticleChatPairs(messages: ArticleChatMessage[]): Array<[ArticleChatMessage, ArticleChatMessage]> {
  const pairs: Array<[ArticleChatMessage, ArticleChatMessage]> = [];
  let pendingUser: ArticleChatMessage | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }
    if (
      pendingUser
      && message.role === "assistant"
      && !message.pending
      && message.content.trim()
      && !message.content.startsWith("AI 问答失败")
      && !message.content.startsWith("已停止生成")
      && !message.content.startsWith("生成超时")
    ) {
      pairs.push([pendingUser, message]);
      pendingUser = null;
    }
  }
  return pairs;
}

export function articleHistoryUserContent(message: ArticleChatMessage): string {
  const selection = (message.requestContext?.selected_text || "").trim();
  if (!selection) return message.content;
  return `[当轮选区: ${selection.slice(0, 300)}] ${message.content}`;
}

export function markCompressedHistoryMessages(
  messagesByMode: ArticleChatMessagesByMode,
  version: number,
): ArticleChatMessagesByMode {
  const next: ArticleChatMessagesByMode = {
    current_article_only: messagesByMode.current_article_only,
    local_web: messagesByMode.local_web,
  };
  for (const key of Object.keys(next) as Array<keyof ArticleChatMessagesByMode>) {
    const pairs = successfulArticleChatPairs(next[key]);
    const compactableIds = new Set(
      pairs
        .slice(0, Math.max(0, pairs.length - 6))
        .flatMap(([user, assistant]) => [user.id, assistant.id]),
    );
    if (!compactableIds.size) continue;
    next[key] = next[key].map((message) =>
      compactableIds.has(message.id) && !message.compressedIntoSummaryVersion
        ? { ...message, compressedIntoSummaryVersion: version }
        : message,
    );
  }
  return next;
}

export function pendingResearchTrace(
  question: string,
  mode: KnowledgeResearchMode,
  forceWeb = false,
): KnowledgeResearchTrace {
  const usesWeb = mode === "web_only" || forceWeb;
  return {
    mode,
    plan_status: usesWeb ? "planned_web_forced_by_mode" : "planned",
    web_search_attempted: usesWeb,
    web_queries: usesWeb ? [question] : [],
    rewritten_web_queries: [],
    search_quality: usesWeb ? { status: "waiting" } : {},
    provider_status: usesWeb ? { stage: "准备发起联网搜索" } : { stage: "准备生成回答" },
    web_sources: [],
    candidate_sources: [],
    query_statuses: [],
    evidence_sources: [],
    clue_sources: [],
    rejected_sources: [],
    knowledge_sources: [],
  };
}

export function applySelectionChatStreamEvent(
  message: ArticleChatMessage,
  event: KnowledgeLibrarySelectionChatStreamEvent,
  mode: KnowledgeResearchMode,
): ArticleChatMessage {
  const trace: KnowledgeResearchTrace = {
    ...pendingResearchTrace("", mode),
    ...(message.researchTrace || {}),
  };
  const providerStatus = {
    ...((trace.provider_status as Record<string, unknown> | undefined) || {}),
  };
  let content = message.content;
  let warnings = message.warnings || [];
  const setProgressContent = (nextContent: string) => {
    if (!trace.answer_streaming) {
      content = nextContent;
    }
  };

  if (event.event === "start") {
    return message;
  }

  switch (event.type) {
    case "planning_start":
      providerStatus.stage = "正在规划检索";
      setProgressContent(mode === "web_only" ? "正在规划联网检索..." : "正在规划回答路径...");
      break;
    case "plan":
      trace.plan_status = event.plan_status || trace.plan_status;
      trace.web_search_attempted = Boolean(event.needs_web);
      trace.web_queries = event.queries || trace.web_queries || [];
      trace.needs_web = Boolean(event.needs_web);
      trace.needs_local = Boolean(event.needs_local);
      trace.complexity = event.complexity || trace.complexity;
      trace.question_type = event.question_type || trace.question_type;
      trace.search_budget = event.search_budget ?? trace.search_budget;
      trace.reason = event.reason || trace.reason;
      trace.query_intent = event.intent_label || trace.query_intent;
      providerStatus.stage = event.needs_web ? "已规划联网查询" : mode === "local_web" ? "跳过联网" : "已规划回答路径";
      setProgressContent(event.needs_web ? "已规划联网查询，准备检索公开网页..." : mode === "current_article_only" ? "正在基于当前文章回答..." : "正在基于可用材料回答...");
      break;
    case "queries_ready":
      trace.web_queries = event.queries || trace.web_queries || [];
      trace.query_count = event.query_count ?? trace.web_queries.length;
      providerStatus.stage = "正在搜索网页";
      setProgressContent("正在搜索网页...");
      break;
    case "local_search_start":
      providerStatus.stage = "正在检索本地资料库";
      setProgressContent("正在检索本地资料库...");
      break;
    case "local_search_done":
      trace.knowledge_sources = mergeResearchSources(trace.knowledge_sources, event.knowledge_sources);
      providerStatus.stage = "本地资料库检索完成";
      setProgressContent("本地资料库检索完成，继续整理证据...");
      break;
    case "web_search_start":
      trace.web_search_attempted = true;
      trace.web_queries = event.queries || trace.web_queries || [];
      providerStatus.stage = "正在发起联网搜索";
      setProgressContent("正在发起联网搜索...");
      break;
    case "web_query_start":
      trace.web_search_attempted = true;
      providerStatus.stage = event.query ? `正在搜索：${event.query}` : "正在搜索网页";
      setProgressContent(event.query ? `正在搜索：${event.query}` : "正在搜索网页...");
      break;
    case "web_query_done":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      trace.candidate_count = event.candidate_count ?? trace.candidate_sources.length;
      trace.query_statuses = mergeQueryStatuses(trace.query_statuses, event.query_status);
      providerStatus.stage = event.query ? `已完成搜索：${event.query}` : "网页搜索完成";
      setProgressContent(`已找到 ${event.result_count ?? event.web_sources?.length ?? 0} 个候选网页，正在筛选来源...`);
      break;
    case "web_query_error":
      trace.query_statuses = mergeQueryStatuses(trace.query_statuses, event.query_status);
      providerStatus.stage = event.query ? `已跳过搜索：${event.query}` : "部分搜索失败";
      setProgressContent("部分搜索失败，正在使用可用结果继续...");
      break;
    case "web_ranked":
      trace.search_quality = event.search_quality || trace.search_quality;
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      trace.candidate_count = event.candidate_count ?? trace.candidate_count ?? trace.candidate_sources.length;
      trace.rewritten_web_queries = event.rewritten_queries || trace.rewritten_web_queries || [];
      providerStatus.stage = "已筛选候选来源";
      setProgressContent("已筛选候选来源，准备整理网页资料...");
      break;
    case "materials_selected":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      trace.candidate_count = event.candidate_count ?? trace.candidate_count;
      trace.material_count = event.material_count ?? trace.material_count;
      trace.opened_pages = event.opened_pages ?? trace.opened_pages;
      providerStatus.stage = event.opened_pages ? "正在阅读网页" : "正在整理搜索摘要";
      setProgressContent(event.opened_pages ? "正在阅读网页..." : "正在整理搜索摘要...");
      break;
    case "web_classified":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.candidate_sources);
      trace.clue_sources = mergeResearchSources(trace.clue_sources, event.clue_sources);
      trace.rejected_sources = mergeResearchSources(trace.rejected_sources, event.rejected_sources);
      providerStatus.stage = "已完成来源分层";
      setProgressContent("已区分采用依据、线索来源和未采用来源...");
      break;
    case "web_rewrite_start":
      trace.rewritten_web_queries = event.queries || trace.rewritten_web_queries || [];
      providerStatus.stage = "正在改写搜索词";
      setProgressContent("搜索结果质量不足，正在改写搜索词...");
      break;
    case "web_fallback_start":
      providerStatus.stage = event.backend ? `正在补充搜索：${event.backend}` : "正在补充搜索";
      providerStatus.fallback_reason = event.reason || providerStatus.fallback_reason;
      setProgressContent(event.backend ? `正在通过 ${event.backend} 补充搜索...` : "正在补充搜索...");
      break;
    case "web_fallback_done":
      trace.search_quality = event.search_quality || trace.search_quality;
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      providerStatus.stage = event.backend ? `补充搜索完成：${event.backend}` : "补充搜索完成";
      providerStatus.fallback_last = event.backend || providerStatus.fallback_last;
      setProgressContent(`补充搜索找到 ${event.result_count ?? event.web_sources?.length ?? 0} 个候选网页，继续筛选...`);
      break;
    case "web_extract_start":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      trace.opened_pages = event.opened_pages ?? trace.opened_pages;
      providerStatus.stage = "正在整理网页资料";
      setProgressContent("正在整理网页来源和可用摘要...");
      break;
    case "web_extract_done":
      trace.provider_status = event.provider_status || trace.provider_status;
      trace.web_sources = mergeResearchSources(trace.web_sources, event.web_sources);
      trace.evidence_sources = mergeResearchSources(trace.evidence_sources, event.evidence_sources || event.web_sources);
      trace.candidate_count = event.candidate_count ?? trace.candidate_count;
      trace.material_count = event.material_count ?? trace.material_count ?? trace.web_sources.length;
      trace.opened_pages = event.opened_pages ?? trace.opened_pages;
      trace.extracted_pages = event.extracted_pages ?? trace.extracted_pages;
      trace.summary_only_pages = event.summary_only_pages ?? trace.summary_only_pages;
      providerStatus.stage = "网页资料整理完成";
      setProgressContent("网页资料整理完成，正在组织回答...");
      break;
    case "web_critic_start":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      providerStatus.stage = "正在核验证据是否支撑回答";
      setProgressContent("正在核验证据是否支撑回答...");
      break;
    case "web_critic_done":
      trace.web_sources = mergeResearchSources(trace.web_sources, event.web_sources);
      trace.evidence_sources = mergeResearchSources(trace.evidence_sources, event.evidence_sources || event.web_sources);
      trace.rejected_sources = mergeResearchSources(trace.rejected_sources, event.rejected_sources);
      providerStatus.stage = "证据核验完成";
      setProgressContent("证据核验完成，正在组织回答...");
      break;
    case "synthesis_start": {
      const eventProviderStatus = event.provider_status && typeof event.provider_status === "object"
        ? event.provider_status as Record<string, unknown>
        : {};
      if (trace.synthesis_skipped || providerStatus.synthesis_skipped || eventProviderStatus.synthesis_skipped) {
        break;
      }
      providerStatus.stage = "正在生成答案";
      if (!trace.answer_streaming) {
        content = "";
        trace.answer_streaming = false;
      }
      break;
    }
    case "answer_delta": {
      const delta = event.delta || "";
      if (!delta) break;
      const wasStreaming = Boolean(trace.answer_streaming);
      trace.answer_streaming = true;
      providerStatus.stage = "正在生成答案";
      content = `${wasStreaming ? content : ""}${delta}`;
      break;
    }
    case "warnings":
      warnings = uniqueStrings([...warnings, ...readableResearchWarnings(event.warnings || [], trace.query_statuses, trace.provider_status)]);
      break;
  }

  trace.provider_status = { ...((trace.provider_status as Record<string, unknown> | undefined) || {}), ...providerStatus };
  return {
    ...message,
    content,
    pending: event.event !== "complete",
    mode,
    sources: {
      knowledge: trace.knowledge_sources || [],
      web: trace.evidence_sources || trace.web_sources || [],
    },
    researchTrace: trace,
    responseMeta: {
      ...(message.responseMeta || {}),
      web_queries: trace.web_queries,
      rewritten_web_queries: trace.rewritten_web_queries,
      search_quality: trace.search_quality,
      provider_status: trace.provider_status,
      research_trace: trace,
      web_search_attempted: Boolean(trace.web_search_attempted),
    },
    warnings,
  };
}

export function mergeQueryStatuses(
  current: unknown,
  incoming: unknown,
): Array<Record<string, unknown>> {
  const currentItems = Array.isArray(current)
    ? current.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  const incomingItems = Array.isArray(incoming)
    ? incoming.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : incoming && typeof incoming === "object"
      ? [incoming as Record<string, unknown>]
      : [];
  const merged = new Map<string, Record<string, unknown>>();
  for (const item of [...currentItems, ...incomingItems]) {
    const key = String(item.query || item.id || JSON.stringify(item));
    merged.set(key, { ...merged.get(key), ...item });
  }
  return Array.from(merged.values());
}

export function mergeResearchSources(
  current: KnowledgeResearchSource[] | undefined,
  incoming: KnowledgeResearchSource[] | undefined,
): KnowledgeResearchSource[] {
  const merged = new Map<string, KnowledgeResearchSource>();
  for (const source of [...(current || []), ...(incoming || [])]) {
    const key = source.url || source.id || source.ref || source.title;
    if (key) {
      merged.set(key, { ...merged.get(key), ...source });
    }
  }
  return Array.from(merged.values());
}

export function articleAssistantRerunAction(message: ArticleChatMessage): { label: string; mode: KnowledgeResearchMode; forceWeb?: boolean } | null {
  if (!message.requestContext) return null;
  switch (message.mode) {
    case "current_article_only":
      return null;
    case "local_only":
      return null;
    case "web_only":
      return null;
    case "local_web": {
      const webAttempted = Boolean(message.researchTrace?.web_search_attempted ?? message.responseMeta?.web_search_attempted);
      return webAttempted
        ? { label: "重新联网检索", mode: "local_web" }
        : { label: "联网补充", mode: "local_web", forceWeb: true };
    }
    default:
      return null;
  }
}

export function reasoningTraceDisplay(trace: NonNullable<KnowledgeLibrarySelectionChatResponse["meta"]>["reasoning_trace"]): string {
  const value = trace?.api_reasoning ?? trace?.reasoning_summary ?? trace?.fallback_reason ?? "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function directAnswerContextLabels(
  trace: KnowledgeResearchTrace | undefined,
  meta: KnowledgeLibrarySelectionChatResponse["meta"] | undefined,
  elapsedLabel: string,
): string[] {
  const audit = (trace || meta?.research_trace || {}) as Record<string, unknown>;
  const selectedTextPresent = audit.selected_text_present === true;
  const selectedTextChars = typeof audit.selected_text_chars === "number" ? audit.selected_text_chars : 0;
  const historyMessageCount = typeof audit.history_message_count === "number" ? audit.history_message_count : 0;
  const historySummaryVersion = typeof audit.history_summary_version === "number" ? audit.history_summary_version : 0;
  return [
    "模式: 直出",
    `本轮选区: ${selectedTextPresent ? `已使用 ${selectedTextChars} 字` : "未使用"}`,
    `最近历史: ${historyMessageCount} 条`,
    `长期摘要版本: v${historySummaryVersion}`,
    elapsedLabel ? `总耗时: ${elapsedLabel}` : "",
  ].filter(Boolean);
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function queryStatusArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

export function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function queryStatusLabel(value: unknown): string {
  switch (String(value || "")) {
    case "success":
      return "成功";
    case "timeout":
      return "超时";
    case "failed":
      return "失败";
    case "skipped":
      return "已跳过";
    default:
      return "未知";
  }
}

export function queryStatusTone(value: unknown): string {
  switch (String(value || "")) {
    case "success":
      return "text-emerald-600";
    case "timeout":
      return "text-warning";
    case "failed":
      return "text-destructive";
    case "skipped":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

export function readableResearchWarnings(
  warnings: string[],
  queryStatuses: unknown,
  providerStatus?: Record<string, unknown>,
): string[] {
  const statusRows = queryStatusArray(queryStatuses || providerStatus?.query_statuses);
  const timeoutCount = statusRows.filter((item) => item.status === "timeout").length;
  const failureCount = statusRows.filter((item) => item.status === "failed").length;
  const usedSourceCount = providerNumber(providerStatus, "used_sources") || providerNumber(providerStatus, "summary_only_pages");
  const suffix = usedSourceCount ? `已用 ${usedSourceCount} 个可用来源继续回答。` : "已用可用材料继续回答。";
  const derived: string[] = [];
  if (timeoutCount) derived.push(`${timeoutCount} 条查询超时，已跳过；${suffix}`);
  if (failureCount) derived.push(`${failureCount} 条查询失败，已跳过；${suffix}`);
  const cleaned = warnings.filter((warning) => {
    if (!warning) return false;
    if (/网页搜索失败|搜索超时：|部分查询失败/.test(warning)) return false;
    return true;
  });
  return uniqueStrings([...derived, ...cleaned]);
}

export function traceSourceCount(sources: unknown): number {
  return Array.isArray(sources) ? sources.length : 0;
}

export function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function providerNumber(providerStatus: unknown, key: string): number {
  if (!providerStatus || typeof providerStatus !== "object") return 0;
  return numberField((providerStatus as Record<string, unknown>)[key]);
}

export function sourceArray(sources: unknown): KnowledgeResearchSource[] {
  return Array.isArray(sources) ? sources.filter((source): source is KnowledgeResearchSource => Boolean(source && typeof source === "object")) : [];
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function researchSummaryText({
  candidateCount,
  elapsedLabel,
  mode,
  pending,
  queryCount,
  readCount,
  sourceCount,
  webSearchAttempted,
}: {
  candidateCount: number;
  elapsedLabel: string;
  mode?: KnowledgeResearchMode;
  pending: boolean;
  queryCount: number;
  readCount: number;
  sourceCount: number;
  webSearchAttempted: boolean;
}): string {
  if (pending) {
    if (!webSearchAttempted) {
      if (mode === "current_article_only") return "正在基于当前文章回答";
      if (mode === "local_only" || mode === "local_web") return "正在检索资料库";
      return "正在回答";
    }
    const parts = ["联网搜索中"];
    if (queryCount) parts.push(`关键词 ${queryCount}`);
    if (candidateCount) parts.push(`找到 ${candidateCount} 页`);
    if (readCount) parts.push(`阅读 ${readCount} 页`);
    return parts.join(" · ");
  }
  const scope = "回答完成";
  const parts = [scope];
  if (sourceCount) parts.push(`使用 ${sourceCount} 个来源`);
  if (elapsedLabel) parts.push(`总耗时 ${elapsedLabel}`);
  return parts.join(" · ");
}

export function researchProgressFallback({
  knowledgeCount,
  mode,
  pending,
  webSearchAttempted,
}: {
  knowledgeCount: number;
  mode?: KnowledgeResearchMode;
  pending: boolean;
  webSearchAttempted: boolean;
}): string {
  if (webSearchAttempted) return pending ? "联网检索中" : "已联网补充";
  if (mode === "current_article_only") return pending ? "正在基于当前文章回答" : "当前文章回答完成";
  if (mode === "local_only") return pending ? "正在检索资料库" : "资料库检索完成";
  if (mode === "local_web") {
    if (pending) return "正在检索资料库";
    return knowledgeCount ? "未联网，已用资料库回答" : "未联网";
  }
  return pending ? "正在回答" : "回答完成";
}

export function researchStatusTitle(mode: KnowledgeResearchMode | undefined, webSearchAttempted: boolean): string {
  if (webSearchAttempted || mode === "web_only") return "搜索状态";
  if (mode === "local_only" || mode === "local_web") return "检索状态";
  return "生成状态";
}

export function researchElapsedLabel(
  trace: KnowledgeResearchTrace | undefined,
  meta: KnowledgeLibrarySelectionChatResponse["meta"] | undefined,
): string {
  const providerStatus = trace?.provider_status ?? meta?.provider_status;
  const rawElapsed = providerStatus && typeof providerStatus === "object"
    ? (providerStatus as Record<string, unknown>).total_elapsed_ms ?? (providerStatus as Record<string, unknown>).search_elapsed_ms
    : undefined;
  if (typeof rawElapsed === "number" && rawElapsed > 0) return formatElapsedMs(rawElapsed);
  const timings = trace?.stage_timings;
  if (!timings || typeof timings !== "object") return "";
  const total = ["planning_ms", "local_search_ms", "search_ms", "extract_ms", "synthesis_ms"].reduce((sum, key) => {
    const value = (timings as Record<string, unknown>)[key];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
  return total > 0 ? formatElapsedMs(total) : "";
}

export function formatElapsedMs(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} 秒`;
}

export function researchSourceReasonLabel(reason: string): string {
  switch (reason) {
    case "wrong_subject":
      return "错实体";
    case "low_quality_clue":
      return "弱来源";
    case "not_preferred_source":
      return "未满足来源偏好";
    case "generic_homepage":
      return "泛化首页";
    case "candidate_evidence":
      return "候选";
    case "adopted_evidence":
      return "已采用";
    case "evidence_critic_clue":
      return "线索";
    case "evidence_critic_rejected":
      return "已拒绝";
    case "summary_only_disallowed":
      return "仅摘要";
    case "stale_for_freshness_sensitive_claim":
      return "时效不足";
    case "weak_secondary":
      return "弱二手来源";
    default:
      return reason;
  }
}

export function researchEvidenceRoleLabel(role: string): string {
  switch (role) {
    case "primary_evidence":
      return "主证据";
    case "supporting_evidence":
      return "辅助证据";
    case "interpretive_evidence":
      return "解释材料";
    case "light_web_material":
      return "采用材料";
    case "clue":
      return "线索";
    case "reject":
      return "拒绝";
    default:
      return role;
  }
}

export function researchModeLabel(mode: KnowledgeResearchMode): string {
  switch (mode) {
    case "current_article_only":
      return "当前文章";
    case "local_only":
      return "资料库";
    case "local_web":
      return "联网搜索 + 资料库";
    case "web_only":
      return "联网";
    case "theme_scan":
      return "跨篇灵感扫描";
  }
}

export function researchStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned_web_forced_by_mode: "按模式强制联网",
    planned: "已规划",
    planned_web: "已规划联网",
    skipped_web: "跳过联网",
  };
  return labels[status] ?? status;
}

export function providerStatusLabels(status: Record<string, unknown> | undefined): string[] {
  if (!status) return [];
  const preferred = [
    "search_backend",
    "extract_backend",
    "total_elapsed_ms",
    "stage_timings",
    "extracted_pages",
    "summary_only_pages",
    "fallback_attempts",
    "retrieval_health",
  ];
  const entries = preferred
    .filter((name) => name in status)
    .map((name) => [name, status[name]] as [string, unknown]);
  return entries
    .slice(0, 8)
    .map(([name, value]) => `${providerStatusName(name)}: ${providerStatusValue(name, value)}`);
}

export function providerStatusName(name: string): string {
  const labels: Record<string, string> = {
    search_backend: "搜索后端",
    extract_backend: "抽取后端",
    total_elapsed_ms: "总耗时",
    stage_timings: "阶段耗时",
    extracted_pages: "全文页",
    summary_only_pages: "摘要页",
    fallback_attempts: "fallback",
    retrieval_health: "检索健康",
  };
  return labels[name] ?? name;
}

export function providerStatusValue(name: string, value: unknown): string {
  if (name.endsWith("_elapsed_ms") && typeof value === "number") {
    return formatElapsedMs(value);
  }
  if (name === "stage_timings" && value && typeof value === "object" && !Array.isArray(value)) {
    return stageTimingLabel(value as Record<string, unknown>);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return "无";
    return value
      .slice(0, 3)
      .map((item) => {
        if (!item || typeof item !== "object") return String(item);
        const record = item as Record<string, unknown>;
        const backend = typeof record.backend === "string" ? record.backend : "backend";
        const count = typeof record.result_count === "number" ? record.result_count : 0;
        return `${backend} ${count}`;
      })
      .join(", ");
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("candidate_count" in record || "independent_domain_count" in record) {
      return `候选 ${record.candidate_count ?? 0} / 独立 ${record.independent_domain_count ?? 0}`;
    }
    const status = record.status ?? record.state ?? record.ok ?? record.error;
    if (typeof status === "string" || typeof status === "number" || typeof status === "boolean") {
      return String(status);
    }
  }
  return "已记录";
}

export function stageTimingLabel(timings: Record<string, unknown>): string {
  const labels: Array<[string, string]> = [
    ["planning_ms", "规划"],
    ["local_search_ms", "资料库"],
    ["search_ms", "联网搜索"],
    ["extract_ms", "网页整理"],
    ["synthesis_ms", "生成答案"],
  ];
  return labels
    .map(([key, label]) => {
      const value = timings[key];
      return typeof value === "number" && value > 0 ? `${label} ${formatElapsedMs(value)}` : "";
    })
    .filter(Boolean)
    .join(" · ") || "已记录";
}
