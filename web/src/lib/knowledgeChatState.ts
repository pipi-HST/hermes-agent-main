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
}

export interface KnowledgeSourceHint {
  id: string;
  label: string;
  url?: string;
  origin: "answer" | "tool";
  excerpt?: string;
  filePath?: string;
  sourceType?: string;
}

export interface KnowledgeChatState {
  connection: ConnectionState;
  sessionId: string | null;
  running: boolean;
  messages: KnowledgeMessage[];
  draftAssistant: KnowledgeMessage | null;
  tools: ToolEntry[];
  sourceHints: KnowledgeSourceHint[];
  error: string | null;
  currentToolName: string | null;
  turnIndex: number;
}

export type KnowledgeChatAction =
  | { type: "connection"; connection: ConnectionState }
  | { type: "session_created"; sessionId: string }
  | { type: "submit_user"; id: string; text: string; createdAt: number }
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
  | { type: "tool_progress"; name?: string; toolId?: string; preview: string }
  | {
      type: "tool_complete";
      toolId: string;
      summary?: string;
      error?: string;
      inlineDiff?: string;
    }
  | { type: "hydrate_messages"; messages: KnowledgeMessage[] }
  | { type: "clear_messages" }
  | { type: "error"; message: string }
  | { type: "reset_error" };

const TOOL_LIMIT = 30;
const SOURCE_LIMIT = 12;

export const initialKnowledgeChatState: KnowledgeChatState = {
  connection: "idle",
  sessionId: null,
  running: false,
  messages: [],
  draftAssistant: null,
  tools: [],
  sourceHints: [],
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
      return { ...state, sessionId: action.sessionId };

    case "submit_user":
      return {
        ...state,
        running: true,
        error: null,
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
      const finalText = action.text || state.draftAssistant?.text || "";
      const message: KnowledgeMessage = {
        id: action.id,
        role: "assistant",
        text: finalText,
        createdAt: action.createdAt,
        status: "complete",
        warning: action.warning,
      };

      return {
        ...state,
        running: false,
        draftAssistant: null,
        messages: [...state.messages, message],
        sourceHints: extractSourceHints(finalText, toolSummaries),
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
          return sameTool ? { ...tool, preview: action.preview } : tool;
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
            }
          : tool,
      );
      const toolSummaries = tools
        .map((tool) => tool.summary)
        .filter((summary): summary is string => Boolean(summary));

      const stillRunning = tools.filter((t) => t.status === "running");
      const nextToolName =
        stillRunning.length > 0
          ? stillRunning[stillRunning.length - 1].name
          : null;

      return {
        ...state,
        tools,
        currentToolName: nextToolName,
        sourceHints: state.messages.length
          ? extractSourceHints(state.messages.at(-1)?.text ?? "", toolSummaries)
          : state.sourceHints,
      };
    }

    case "hydrate_messages": {
      const lastAssistant = [...action.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      return {
        ...state,
        running: false,
        draftAssistant: null,
        messages: action.messages,
        sourceHints: extractSourceHints(lastAssistant?.text ?? ""),
      };
    }

    case "clear_messages":
      return {
        ...state,
        running: false,
        draftAssistant: null,
        messages: [],
        sourceHints: [],
        tools: [],
        currentToolName: null,
        turnIndex: 0,
      };

    case "error":
      return { ...state, error: action.message, running: false };

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
  collectStructuredSources(answerText, "answer", hints);
  for (const summary of toolSummaries) {
    collectStructuredSources(summary, "tool", hints);
  }

  // Heuristic fallback
  collectSourceLines(answerText, "answer", hints);
  collectLinks(answerText, "answer", hints);
  collectBracketSources(answerText, "answer", hints);

  for (const summary of toolSummaries) {
    collectSourceLines(summary, "tool", hints);
    collectLinks(summary, "tool", hints);
    collectBracketSources(summary, "tool", hints);
  }

  const seen = new Set<string>();
  const deduped: KnowledgeSourceHint[] = [];
  for (const hint of hints) {
    const key = `${hint.label.trim()}|${hint.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...hint, id: `source-${deduped.length + 1}` });
    if (deduped.length >= SOURCE_LIMIT) break;
  }

  return deduped;
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
