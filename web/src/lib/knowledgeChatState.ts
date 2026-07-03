import type { ConnectionState } from "@/lib/gatewayClient";
import type { ToolEntry } from "@/components/ToolCall";

export type KnowledgeMessageRole = "user" | "assistant";

export interface KnowledgeMessage {
  id: string;
  role: KnowledgeMessageRole;
  text: string;
  createdAt: number;
  status?: "streaming" | "complete" | "error";
  warning?: string;
  sourceHints?: KnowledgeSourceHint[];
}

export interface KnowledgeSourceHint {
  id: string;
  sourceId?: string;
  label: string;
  ref?: string;
  url?: string;
  origin: "answer" | "tool";
  domain?: string;
  excerpt?: string;
  filePath?: string;
  itemId?: string;
  itemKind?: string;
  openUrl?: string;
  fileUrl?: string;
  path?: string;
  sourceType?: string;
}

export interface KnowledgeChatState {
  connection: ConnectionState;
  sessionId: string | null;
  running: boolean;
  interruptRequested: boolean;
  messages: KnowledgeMessage[];
  draftAssistant: KnowledgeMessage | null;
  tools: ToolEntry[];
  sourceHints: KnowledgeSourceHint[];
  toolSourceHints: KnowledgeSourceHint[];
  toolCandidateSourceHints: KnowledgeSourceHint[];
  toolAnswerText: string;
  error: string | null;
  currentToolName: string | null;
  turnIndex: number;
}

export type KnowledgeChatAction =
  | { type: "connection"; connection: ConnectionState }
  | { type: "session_created"; sessionId: string }
  | { type: "submit_user"; id: string; text: string; createdAt: number }
  | { type: "interrupt_requested" }
  | { type: "message_start"; id: string; createdAt: number }
  | { type: "message_delta"; text: string }
  | {
      type: "message_complete";
      id: string;
      text: string;
      createdAt: number;
      warning?: string;
    }
  | { type: "tool_start"; toolId: string; name: string; context?: string }
  | { type: "tool_progress"; name?: string; toolId?: string; preview: string; stage?: string; status?: string }
  | {
      type: "tool_complete";
      toolId: string;
      summary?: string;
      error?: string;
      inlineDiff?: string;
      progressEvents?: ToolEntry["progressEvents"];
      answerText?: string;
      knowledgeSources?: Array<Record<string, unknown>>;
      sourceMap?: Array<Record<string, unknown>>;
      webSources?: Array<Record<string, unknown>>;
      retrievedWebSources?: Array<Record<string, unknown>>;
    }
  | {
      type: "hydrate_messages";
      messages: KnowledgeMessage[];
      tools?: ToolEntry[];
      toolSummaries?: string[];
    }
  | { type: "clear_messages" }
  | { type: "error"; message: string }
  | { type: "reset_error" };

const TOOL_LIMIT = 30;
const SOURCE_LIMIT_PER_KIND = 10;
const RETRIEVED_WEB_FALLBACK_LIMIT = 4;

export const initialKnowledgeChatState: KnowledgeChatState = {
  connection: "idle",
  sessionId: null,
  running: false,
  interruptRequested: false,
  messages: [],
  draftAssistant: null,
  tools: [],
  toolSourceHints: [],
  toolCandidateSourceHints: [],
  sourceHints: [],
  toolAnswerText: "",
  error: null,
  currentToolName: null,
  turnIndex: 0,
};

export function knowledgeChatReducer(
  state: KnowledgeChatState,
  action: KnowledgeChatAction,
): KnowledgeChatState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.connection };

    case "session_created":
      return { ...state, sessionId: action.sessionId, interruptRequested: false };

    case "submit_user":
      return {
        ...state,
        running: true,
        interruptRequested: false,
        error: null,
        toolSourceHints: [],
        toolCandidateSourceHints: [],
        sourceHints: [],
        toolAnswerText: "",
        turnIndex: state.turnIndex + 1,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: "user",
            text: action.text,
            createdAt: action.createdAt,
            status: "complete",
          },
        ],
      };

    case "interrupt_requested":
      return { ...state, interruptRequested: true };

    case "message_start":
      return {
        ...state,
        draftAssistant: {
          id: action.id,
          role: "assistant",
          text: "",
          createdAt: action.createdAt,
          status: "streaming",
        },
      };

    case "message_delta": {
      const draft =
        state.draftAssistant ??
        ({
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: "",
          createdAt: Date.now(),
          status: "streaming",
        } satisfies KnowledgeMessage);

      return {
        ...state,
        draftAssistant: {
          ...draft,
          text: draft.text + action.text,
        },
      };
    }

    case "message_complete": {
      const toolSummaries = state.tools
        .map((tool) => tool.summary)
        .filter((summary): summary is string => Boolean(summary));
      const finalText = state.toolAnswerText || action.text || state.draftAssistant?.text || "";
      const messageSourceHints = buildAnswerSourceHints(
        finalText,
        toolSummaries,
        state.toolSourceHints,
        state.toolCandidateSourceHints,
      );
      const message: KnowledgeMessage = {
        id: action.id,
        role: "assistant",
        text: finalText,
        createdAt: action.createdAt,
        status: "complete",
        warning: action.warning,
        sourceHints: messageSourceHints,
      };

      return {
        ...state,
        running: false,
        interruptRequested: false,
        currentToolName: null,
        draftAssistant: null,
        messages: [...state.messages, message],
        sourceHints: messageSourceHints,
        toolSourceHints: [],
        toolCandidateSourceHints: [],
        toolAnswerText: "",
      };
    }

    case "tool_start": {
      const entry: ToolEntry = {
        kind: "tool",
        id: `tool-${action.toolId}-${Date.now()}`,
        tool_id: action.toolId,
        name: action.name,
        context: action.context,
        status: "running",
        startedAt: Date.now(),
        turnIndex: state.turnIndex,
      };

      return {
        ...state,
        tools: [...state.tools, entry].slice(-TOOL_LIMIT),
        currentToolName: action.name,
      };
    }

    case "tool_progress":
      return {
        ...state,
        tools: state.tools.map((tool) => {
          const sameTool = action.toolId
            ? tool.tool_id === action.toolId
            : action.name
              ? tool.name === action.name && tool.status === "running"
              : false;
          if (!sameTool) return tool;
          const progressEvents = [
            ...(tool.progressEvents ?? []),
            {
              preview: action.preview,
              stage: action.stage,
              status: action.status,
              at: Date.now(),
            },
          ].slice(-20);
          return { ...tool, preview: action.preview, progressEvents };
        }),
      };

    case "tool_complete": {
      const tools = state.tools.map((tool) =>
        tool.tool_id === action.toolId
          ? {
              ...tool,
              status: action.error ? ("error" as const) : ("done" as const),
              summary: action.summary,
              error: action.error,
              inline_diff: action.inlineDiff,
              completedAt: Date.now(),
              progressEvents: mergeToolProgressEvents(
                tool.progressEvents,
                action.progressEvents ?? toolProgressEventsFromSummary(action.summary),
              ),
            }
          : tool,
      );

      const stillRunning = tools.filter((t) => t.status === "running");
      const nextToolName =
        stillRunning.length > 0
          ? stillRunning[stillRunning.length - 1].name
          : null;

      const parsedToolHints = mergeSourceHints([
        ...state.toolSourceHints,
        ...sourceHintsFromRawSources(action.sourceMap, "tool"),
        ...sourceHintsFromRawSources(action.knowledgeSources, "tool"),
        ...sourceHintsFromRawSources(action.webSources, "tool"),
      ]);
      const parsedCandidateHints = dedupeSourceHints([
        ...state.toolCandidateSourceHints,
        ...sourceHintsFromRawSources(action.retrievedWebSources, "tool"),
      ]);

      return {
        ...state,
        tools,
        currentToolName: nextToolName,
        toolSourceHints: parsedToolHints,
        sourceHints: parsedToolHints,
        toolCandidateSourceHints: parsedCandidateHints,
        toolAnswerText: action.answerText || state.toolAnswerText,
      };
    }

    case "hydrate_messages": {
      const toolSummaries = action.toolSummaries ??
        (action.tools ?? [])
          .map((tool) => tool.summary)
          .filter((summary): summary is string => Boolean(summary));
      const messages = action.messages.map((message) => {
        if (message.role !== "assistant") return message;
        const sourceHints = message.sourceHints?.length
          ? message.sourceHints
          : buildAnswerSourceHints(message.text, toolSummaries);
        return { ...message, sourceHints };
      });
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
      return {
        ...state,
        running: false,
        interruptRequested: false,
        currentToolName: null,
        draftAssistant: null,
        messages,
        tools: action.tools ?? state.tools,
        sourceHints: lastAssistant?.sourceHints?.length
          ? lastAssistant.sourceHints
          : buildAnswerSourceHints(lastAssistant?.text ?? "", toolSummaries),
        toolSourceHints: [],
        toolCandidateSourceHints: [],
        toolAnswerText: "",
      };
    }

    case "clear_messages":
      return {
        ...state,
        running: false,
        interruptRequested: false,
        draftAssistant: null,
        messages: [],
        sourceHints: [],
        toolSourceHints: [],
        toolCandidateSourceHints: [],
        toolAnswerText: "",
        tools: [],
        currentToolName: null,
        turnIndex: 0,
      };

    case "error":
      return { ...state, error: action.message, running: false, interruptRequested: false, currentToolName: null };

    case "reset_error":
      return { ...state, error: null };
  }
}

export function extractSourceHints(
  answerText: string,
  toolSummaries: string[] = [],
): KnowledgeSourceHint[] {
  const hints: KnowledgeSourceHint[] = [];

  // Structured sources first (highest confidence)
  collectEnvelopeSources(answerText, "answer", hints);
  collectStructuredSources(answerText, "answer", hints);
  for (const summary of toolSummaries) {
    collectEnvelopeSources(summary, "tool", hints);
    collectStructuredSources(summary, "tool", hints);
  }

  // Heuristic fallback
  collectSourceLines(answerText, "answer", hints);
  collectLinks(answerText, "answer", hints);
  collectBracketSources(answerText, "answer", hints);

  const preferredRefs = sourceRefsFromText(answerText);
  const merged = mergeSourceHints(hints, preferredRefs);
  const fallbackWeb = fallbackWebCandidates(
    merged,
    extractCandidateSourceHints(toolSummaries),
  );
  return fallbackWeb.length ? mergeSourceHints([...merged, ...fallbackWeb], preferredRefs) : merged;
}

function buildAnswerSourceHints(
  answerText: string,
  toolSummaries: string[] = [],
  baseHints: KnowledgeSourceHint[] = [],
  candidateHints: KnowledgeSourceHint[] = [],
): KnowledgeSourceHint[] {
  const preferredRefs = sourceRefsFromText(answerText);
  const formalHints = mergeSourceHints(
    [
      ...baseHints,
      ...extractSourceHints(answerText, toolSummaries),
    ],
    preferredRefs,
  );
  const candidatePool = [...candidateHints, ...extractCandidateSourceHints(toolSummaries)];
  const promoted = promoteCitedCandidates(
    answerText,
    formalHints,
    candidatePool,
  );
  const fallbackWeb = fallbackWebCandidates([...formalHints, ...promoted], candidatePool);
  return mergeSourceHints([...formalHints, ...promoted, ...fallbackWeb], preferredRefs);
}

function extractCandidateSourceHints(toolSummaries: string[] = []): KnowledgeSourceHint[] {
  const hints: KnowledgeSourceHint[] = [];
  for (const summary of toolSummaries) {
    for (const payload of extractStructuredPayloads(summary)) {
      collectRetrievedWebSources(payload, "tool", hints);
    }
  }
  return dedupeSourceHints(hints);
}

function promoteCitedCandidates(
  answerText: string,
  formalHints: KnowledgeSourceHint[],
  candidateHints: KnowledgeSourceHint[],
): KnowledgeSourceHint[] {
  if (!candidateHints.length) return [];
  const citedRefs = new Set(sourceRefsFromText(answerText).filter((ref) => ref.startsWith("W")));
  if (!citedRefs.size) return [];
  const formalRefs = new Set(formalHints.flatMap((hint) => sourceRefAliases(sourceRef(hint))));
  return candidateHints.filter((hint) => {
    const aliases = sourceRefAliases(sourceRef(hint));
    return aliases.some((ref) => citedRefs.has(ref)) && !aliases.some((ref) => formalRefs.has(ref));
  });
}

function fallbackWebCandidates(
  formalHints: KnowledgeSourceHint[],
  candidateHints: KnowledgeSourceHint[],
): KnowledgeSourceHint[] {
  if (formalHints.some(isWebSourceHint)) return [];
  return candidateHints
    .filter(isWebSourceHint)
    .slice(0, RETRIEVED_WEB_FALLBACK_LIMIT);
}

export function extractFullAnswerText(
  answerText: string,
  toolSummaries: string[] = [],
): string {
  const payloads = [
    ...toolSummaries.flatMap((summary) => extractStructuredPayloads(summary)),
    ...extractStructuredPayloads(answerText),
  ];
  for (let index = payloads.length - 1; index >= 0; index--) {
    const meta = payloads[index].meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    const value = (meta as Record<string, unknown>).answer;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function toolProgressEventsFromSummary(
  summary: string | undefined,
  at: number = Date.now(),
): ToolEntry["progressEvents"] {
  if (!summary?.trim()) return undefined;
  const events = extractStructuredPayloads(summary).flatMap((payload) => {
    const meta = objectRecord(payload.meta);
    const items: NonNullable<ToolEntry["progressEvents"]> = [];
    const intent = stringField(payload.intent) || stringField(meta.intent);
    const status = stringField(payload.status);
    const draftStatus = stringField(meta.draft_status);
    const title = stringField(meta.title);
    const wordCount = numberField(meta.word_count);
    const captureIntent = objectRecord(meta.capture_intent);
    const materialIntent = stringField(captureIntent.material_intent);
    const outputShape = Array.isArray(captureIntent.output_shape)
      ? captureIntent.output_shape.map(String).join(", ")
      : "";

    if (intent || status) {
      items.push({
        preview: ["工具合同", intent, status ? `状态 ${status}` : ""].filter(Boolean).join(" · "),
        stage: "tool_contract",
        status: status === "error" ? "warning" : "completed",
        at,
      });
    }
    if (title || draftStatus || wordCount !== null) {
      items.push({
        preview: [
          title ? `标题：${title}` : "",
          draftStatus ? `草稿状态：${draftStatus}` : "",
          wordCount !== null ? `${wordCount} 字` : "",
        ].filter(Boolean).join(" · "),
        stage: "draft_state",
        status: "completed",
        at: at + items.length,
      });
    }
    if (materialIntent || outputShape) {
      items.push({
        preview: [
          materialIntent ? `材料意图：${materialIntent}` : "",
          outputShape ? `输出形态：${outputShape}` : "",
        ].filter(Boolean).join(" · "),
        stage: "capture_intent",
        status: "completed",
        at: at + items.length,
      });
    }

    const timings = objectRecord(meta.stage_timings_ms);
    for (const [key, value] of Object.entries(timings)) {
      const ms = numberField(value);
      if (ms === null || ms <= 0) continue;
      items.push({
        preview: `${captureStageLabel(key)}：${formatDuration(ms)}`,
        stage: key,
        status: "completed",
        at: at + items.length,
      });
    }

    const artifacts = Array.isArray(payload.durable_artifacts) ? payload.durable_artifacts.length : 0;
    const actions = Array.isArray(payload.next_actions) ? payload.next_actions.length : 0;
    if (artifacts || actions) {
      items.push({
        preview: [`生成材料 ${artifacts} 个`, `可选动作 ${actions} 个`].join(" · "),
        stage: "tool_outputs",
        status: "completed",
        at: at + items.length,
      });
    }
    return items;
  });
  return events.length ? events.slice(-20) : undefined;
}

function mergeToolProgressEvents(
  existing: ToolEntry["progressEvents"],
  next: ToolEntry["progressEvents"],
): ToolEntry["progressEvents"] {
  if (!next?.length) return existing;
  return [...(existing ?? []), ...next].slice(-20);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function captureStageLabel(key: string): string {
  const labels: Record<string, string> = {
    extract_clean: "提取与清洗",
    intent_planning: "意图规划",
    draft_create: "创建草稿",
    finalize_for_commit: "确认前整理",
    revision_llm: "生成整理稿",
    metadata_summary: "生成摘要标签",
    repo_update: "保存状态",
    total: "总耗时",
  };
  return labels[key] ?? key;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function mergeSourceHints(
  hints: KnowledgeSourceHint[],
  preferredRefs: string[] = [],
): KnowledgeSourceHint[] {
  const deduped = dedupeSourceHints(hints);
  const ordered = prioritizeSourceHints(deduped, preferredRefs);
  const limited = [
    ...ordered.filter((hint) => !isWebSourceHint(hint)).slice(0, SOURCE_LIMIT_PER_KIND),
    ...ordered.filter(isWebSourceHint).slice(0, SOURCE_LIMIT_PER_KIND),
  ].slice(0, SOURCE_LIMIT_PER_KIND * 2);
  let webIndex = 0;
  let knowledgeIndex = 0;
  return limited.map((hint, index) => {
    const isWeb = isWebSourceHint(hint);
    const ref = hint.ref || (isWeb ? `W${++webIndex}` : `K${++knowledgeIndex}`);
    return { ...hint, id: `source-${index + 1}`, ref };
  });
}

function dedupeSourceHints(hints: KnowledgeSourceHint[]): KnowledgeSourceHint[] {
  const seen = new Set<string>();
  const deduped: KnowledgeSourceHint[] = [];
  for (const hint of hints) {
    const normalized = hint.label.trim().replace(/^\[\d+\]\s*/, "");
    const key = `${hint.sourceId ?? ""}|${hint.itemKind ?? ""}|${hint.itemId ?? ""}|${normalized}|${hint.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...hint, id: hint.id || `source-${deduped.length + 1}` });
  }
  return deduped;
}

export function isKnowledgeSourceHint(hint: KnowledgeSourceHint): boolean {
  const sourceType = (hint.sourceType || "").toLowerCase();
  const ref = sourceRef(hint);
  return Boolean(
    hint.itemKind ||
    sourceType === "knowledge" ||
    sourceType === "capture" ||
    sourceType === "capture_note" ||
    sourceType === "capture_section" ||
    sourceType === "capture_draft" ||
    ref.startsWith("K") ||
    /^\d+$/.test(ref),
  );
}

function isWebSourceHint(hint: KnowledgeSourceHint): boolean {
  if (isKnowledgeSourceHint(hint)) return false;
  const sourceType = (hint.sourceType || "").toLowerCase();
  return Boolean(sourceType === "web" || hint.ref?.toUpperCase().startsWith("W"));
}

function sourceHintsFromRawSources(
  sources: Array<Record<string, unknown>> | undefined,
  origin: KnowledgeSourceHint["origin"],
): KnowledgeSourceHint[] {
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source, index) => {
    const hint = sourceHintFromRecord(source, origin, index);
    return hint ? [hint] : [];
  });
}

function prioritizeSourceHints(
  hints: KnowledgeSourceHint[],
  preferredRefs: string[],
): KnowledgeSourceHint[] {
  if (!preferredRefs.length) return hints;
  const used = new Set<number>();
  const ordered: KnowledgeSourceHint[] = [];
  for (const ref of preferredRefs) {
    const index = hints.findIndex((hint, hintIndex) =>
      !used.has(hintIndex) && sourceHintHasRef(hint, ref)
    );
    if (index < 0) continue;
    used.add(index);
    ordered.push(hints[index]);
  }
  hints.forEach((hint, index) => {
    if (!used.has(index)) ordered.push(hint);
  });
  return ordered;
}

function sourceRefsFromText(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\\?\[([KW]?\d+)\\?\]/gi)) {
    const ref = match[1].toUpperCase();
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function sourceRef(hint: KnowledgeSourceHint): string {
  return (hint.ref || "").trim().toUpperCase();
}

function sourceHintHasRef(hint: KnowledgeSourceHint, ref: string): boolean {
  return sourceRefAliases(sourceRef(hint)).includes(ref);
}

function sourceRefAliases(ref: string): string[] {
  if (!ref) return [];
  const aliases = [ref];
  const numeric = ref.match(/^K(\d+)$/i)?.[1];
  if (numeric) aliases.push(numeric);
  if (/^\d+$/.test(ref)) aliases.push(`K${ref}`);
  return aliases;
}

function sourceHintFromRecord(
  record: Record<string, unknown>,
  origin: KnowledgeSourceHint["origin"],
  index: number,
): KnowledgeSourceHint | null {
  const title = stringField(record.title) || stringField(record.label) || stringField(record.id);
  if (!title) return null;
  const sourceType = stringField(record.type) || undefined;
  const sourceId = stringField(record.id) || stringField(record.url) || undefined;
  const itemKind = stringField(record.item_kind) || inferredItemKind(sourceType);
  const itemId = stringField(record.item_id) || (itemKind ? stringField(record.id) : "");
  const path = stringField(record.path) || undefined;
  const filePath = stringField(record.file_path) || path;
  const ref = stringField(record.ref) || inferredRef(sourceType, index);
  const section = stringField(record.section);
  return {
    id: "",
    sourceId,
    label: section ? `${title} / ${section}` : title,
    ref,
    origin,
    domain: stringField(record.domain) || undefined,
    excerpt: stringField(record.excerpt) || stringField(record.description) || undefined,
    filePath,
    itemId: itemId || undefined,
    itemKind: itemKind || undefined,
    fileUrl: stringField(record.file_url) || undefined,
    openUrl: stringField(record.open_url) || inferredOpenUrl(itemKind, itemId),
    path,
    sourceType,
    url: stringField(record.url) || undefined,
  };
}

function inferredItemKind(sourceType?: string): string {
  const normalized = (sourceType || "").toLowerCase();
  return normalized === "capture" || normalized === "capture_note" || normalized === "capture_section"
    ? "capture"
    : normalized === "capture_draft"
      ? "capture_draft"
      : "";
}

function inferredOpenUrl(itemKind: string, itemId: string): string | undefined {
  return itemKind && itemId
    ? `/knowledge-library?kind=${encodeURIComponent(itemKind)}&item=${encodeURIComponent(itemId)}`
    : undefined;
}

function inferredRef(sourceType: string | undefined, index: number): string | undefined {
  if (!sourceType) return undefined;
  const normalized = sourceType.toLowerCase();
  if (normalized === "web") return `W${index + 1}`;
  if (normalized === "knowledge" || normalized.startsWith("capture")) return `${index + 1}`;
  return undefined;
}

function collectSourceLines(
  text: string,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  const lines = text.split("\n");
  let inSources = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inSources) break;
      continue;
    }

    if (/^#{0,3}\s*(参考来源|来源|引用|references?)\s*[:：]?$/i.test(line)) {
      inSources = true;
      continue;
    }

    if (inSources && /^#{1,4}\s+/.test(line)) break;

    if (inSources) {
      const cleaned = line
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+[.)、]\s*/, "")
        .trim();
      if (cleaned) hints.push({ id: "", label: cleaned, origin });
    }
  }
}

function collectLinks(
  text: string,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of text.matchAll(markdownLink)) {
    hints.push({ id: "", label: match[1].trim(), url: match[2], origin });
  }

  const bareUrl = /\bhttps?:\/\/[^\s<>)\]]+/g;
  for (const match of text.matchAll(bareUrl)) {
    hints.push({ id: "", label: match[0], url: match[0], origin });
  }
}

function collectBracketSources(
  text: string,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  const citationLine = /^\s*\[(\d+)\]\s+(.+)$/gm;
  for (const match of text.matchAll(citationLine)) {
    hints.push({ id: "", label: `[${match[1]}] ${match[2].trim()}`, origin });
  }
}

function collectEnvelopeSources(
  text: string,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  for (const payload of extractStructuredPayloads(text)) {
    const sources = Array.isArray(payload.source_map)
      ? payload.source_map
      : Array.isArray(payload.sources)
        ? payload.sources
        : [];
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const record = source as Record<string, unknown>;
      const title = stringField(record.title) || stringField(record.label) || stringField(record.id);
      if (!title) continue;
      const hint = sourceHintFromRecord(record, origin, hints.length);
      if (hint) hints.push(hint);
    }
    collectMetaSources(payload, origin, hints);
    collectWebSearchPayloadSources(payload, origin, hints);
    collectWebExtractPayloadSources(payload, origin, hints);
  }
}

function collectMetaSources(
  payload: Record<string, unknown>,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  const meta = payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
    ? payload.meta as Record<string, unknown>
    : {};
  for (const key of ["knowledge_sources", "web_sources", "retrieved_knowledge_sources"]) {
    const sources = Array.isArray(meta[key]) ? meta[key] : [];
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const record = source as Record<string, unknown>;
      const type = key.includes("web")
        ? "web"
        : stringField(record.type) || "knowledge";
      const hint = sourceHintFromRecord({ ...record, type }, origin, hints.length);
      if (hint) hints.push(hint);
    }
  }
}

function collectRetrievedWebSources(
  payload: Record<string, unknown>,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  const meta = payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
    ? payload.meta as Record<string, unknown>
    : {};
  const sources = Array.isArray(meta.retrieved_web_sources) ? meta.retrieved_web_sources : [];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const hint = sourceHintFromRecord({ ...(source as Record<string, unknown>), type: "web" }, origin, hints.length);
    if (hint?.url) hints.push(hint);
  }
}

function collectWebSearchPayloadSources(
  payload: Record<string, unknown>,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload;
  const web = Array.isArray(data.web) ? data.web : [];
  for (const source of web) {
    if (!source || typeof source !== "object") continue;
    const hint = sourceHintFromRecord({ ...(source as Record<string, unknown>), type: "web" }, origin, hints.length);
    if (hint?.url) hints.push(hint);
  }
}

function collectWebExtractPayloadSources(
  payload: Record<string, unknown>,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload;
  const results = Array.isArray(data.results) ? data.results : [];
  for (const source of results) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    if (record.error || !stringField(record.content)) continue;
    const hint = sourceHintFromRecord({ ...record, type: "web" }, origin, hints.length);
    if (hint?.url) hints.push(hint);
  }
}

function extractStructuredPayloads(text: string): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];
  const marker = "STRUCTURED_AGENT_RESULT_DO_NOT_REWRITE:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    const afterMarker = text.slice(markerIndex + marker.length).trim();
    const parsed = parseJsonObjectPrefix(afterMarker);
    if (parsed) payloads.push(parsed);
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed = parseJsonObjectPrefix(trimmed);
    if (parsed) payloads.push(parsed);
  }
  return payloads;
}

function parseJsonObjectPrefix(text: string): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(0, end));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse structured source blocks commonly emitted by RAG / knowledge tools.
 *
 * Recognized patterns (per line):
 *   - [source_type] Title (file/path) — excerpt
 *   - [source_type] Title — excerpt
 *   - Title (file/path) — excerpt
 */
function collectStructuredSources(
  text: string,
  origin: KnowledgeSourceHint["origin"],
  hints: KnowledgeSourceHint[],
) {
  // Pattern: - [type] Label (path) — excerpt   OR   - [type] Label — excerpt
  const structured =
    /^[-*]\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(([^)]+)\))?(?:\s*[—–-]\s*(.+))?$/gm;
  for (const match of text.matchAll(structured)) {
    const sourceType = match[1].trim();
    const label = match[2].trim();
    const filePath = match[3]?.trim() || undefined;
    const excerpt = match[4]?.trim() || undefined;
    hints.push({ id: "", label, origin, sourceType, filePath, excerpt });
  }
}
