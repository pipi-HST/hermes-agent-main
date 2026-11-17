import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { ToolEntry } from "@/components/ToolCall";
import { ResizableRail, readStoredWidth } from "@/components/ResizableRail";
import {
  api,
  createAiOperationId,
  type KnowledgeCaptureDraft,
  type KnowledgeGardenDraftResponse,
  type KnowledgeLibraryFolder,
  type KnowledgeObjectEvent,
  type KnowledgeReadingDraft,
  type KnowledgeChatResearchMode,
  type KnowledgeResearchMode,
  type SessionInfo,
} from "@/lib/api";
import {
  acquireGatewayClient,
  releaseGatewayClient,
  type ConnectionState,
} from "@/lib/gatewayClient";
import {
  extractFullAnswerText,
  extractSourceHints,
  initialKnowledgeChatState,
  knowledgeChatReducer,
  searchBackendFromToolSummaries,
  searchBackendFromTrace,
  toolProgressEventsFromSummary,
  type KnowledgeMessage,
} from "@/lib/knowledgeChatState";
import { cn } from "@/lib/utils";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

type DraftActionLoading = "commit" | "revise" | "card" | "delete" | null;
type AiOperationState = { id: string; label: string; controller: AbortController; stopping: boolean } | null;

function isAiCancelledResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.cancelled === true || record.status === "cancelled";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isCommittedCaptureDraft(draft: KnowledgeCaptureDraft): boolean {
  return draft.status === "committed" || Boolean(draft.committed_capture_id?.trim());
}

import { WorkbenchSidebar } from "@/pages/knowledge-chat/WorkbenchSidebar";
import { ReadingDraftReview } from "@/pages/knowledge-chat/ReadingDraftReview";
import { DraftReview } from "@/pages/knowledge-chat/DraftReview";
import {
  EditableCaptureWorkbench,
  type EditableCardCommitStatus,
  type EditableCaptureStatus,
} from "@/pages/knowledge-chat/EditableCaptureWorkbench";
import { KnowledgeInspector } from "@/pages/knowledge-chat/Inspector";
import { GatewayChat } from "@/pages/knowledge-chat/GatewayChat";
import { resolveKnowledgeDraftReference } from "@/pages/knowledge-chat/draftRouting.mjs";
import {
  HIDDEN_DRAFT_STATUSES,
  OPEN_STATUSES,
  objectEventToToolEntry,
  readingDraftCaptureId,
  sourceHintsFromCaptureDraft,
  sourceHintsFromMetaSources,
  type AnswerDraftActionLoading,
  type AnswerOutputType,
  type ComposerAttachment,
  type DraftFilterKey,
  type DraftView,
  type InspectorObjectRef,
  type InspectorTab,
  type WorkbenchMode,
  type WorkbenchSelection,
} from "@/pages/knowledge-chat/shared";

interface MessageCompletePayload {
  text?: string;
  status?: string;
  warning?: string;
}

interface MessageDeltaPayload {
  text?: string;
}

interface ToolStartPayload {
  tool_id?: string;
  name?: string;
  context?: string;
}

interface ToolProgressPayload {
  tool_id?: string;
  name?: string;
  preview?: string;
  stage?: string;
  status?: string;
}

interface ToolCompletePayload {
  tool_id?: string;
  name?: string;
  summary?: string;
  error?: string;
  inline_diff?: string;
  answer_text?: string;
  knowledge_sources?: Array<Record<string, unknown>>;
  source_map?: Array<Record<string, unknown>>;
  web_sources?: Array<Record<string, unknown>>;
  retrieved_web_sources?: Array<Record<string, unknown>>;
  research_trace?: Record<string, unknown>;
}

interface ErrorPayload {
  message?: string;
}

interface GatewayResumeMessage {
  role?: "user" | "assistant" | "system" | "tool";
  text?: string;
  content?: string;
  name?: string;
  context?: string;
  tool_name?: string;
  source_map?: Array<Record<string, unknown>>;
  knowledge_sources?: Array<Record<string, unknown>>;
  web_sources?: Array<Record<string, unknown>>;
  retrieved_web_sources?: Array<Record<string, unknown>>;
  research_trace?: Record<string, unknown>;
  answer_text?: string;
}

interface GatewayResumeResponse {
  session_id: string;
  resumed?: string;
  messages?: GatewayResumeMessage[];
}

interface GatewayHistoryResponse {
  count?: number;
  messages?: GatewayResumeMessage[];
}

interface GatewayAppendLocalMessagesResponse {
  appended: number;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"]);
const WORKBENCH_CACHE_KEY = "hermes-knowledge-workbench-cache-v1";
const WORKBENCH_LAST_SESSION_KEY = "hermes-knowledge-workbench-last-session-v1";
const PROMPT_SUBMIT_TIMEOUT_MS = 300_000;
const HISTORY_RECONCILE_INTERVAL_MS = 2_000;
const HISTORY_RECONCILE_MAX_MS = 90_000;
const HISTORY_RECONCILE_IDLE_MS = 3_000;
const KNOWLEDGE_TOOLSETS = ["knowledge-web-research"];
const KNOWLEDGE_TOOLSETS_BY_MODE: Record<KnowledgeChatResearchMode, string[]> = {
  local_only: ["knowledge-local"],
  local_web: ["knowledge-web-research"],
  // toolsets.py exposes theme_scan/theme_candidates/generate_canvas as "knowledge-advanced".
  theme_scan: ["knowledge-local", "knowledge-advanced"],
};
const CHAT_SIDEBAR_WIDTH_KEY = "hermes.knowledgeChat.sidebarWidth";
const CHAT_INSPECTOR_WIDTH_KEY = "hermes.knowledgeChat.inspectorWidth";
const DEFAULT_CHAT_SIDEBAR_WIDTH = 280;
const DEFAULT_CHAT_INSPECTOR_WIDTH = 320;

function gardenDraftNotice(result: KnowledgeGardenDraftResponse): string {
  const title = result.meta?.title;
  if (typeof title === "string" && title.trim()) {
    return `已生成知识卡片草稿：《${title.trim()}》。`;
  }
  const previewLine = (result.chat_preview || result.USER_VISIBLE_REPLY || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return previewLine || "已生成知识卡片草稿。";
}

function gardenDraftError(result: KnowledgeGardenDraftResponse): string {
  return result.error || result.errors?.[0] || result.USER_VISIBLE_REPLY || result.chat_preview || "生成知识卡片草稿失败。";
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "已连接",
  closed: "已断开",
  error: "连接错误",
};

export default function KnowledgeChatPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const isCaptureReviewRoute = (pathname.replace(/\/$/, "") || "/") === "/capture-review";
  const [version, setVersion] = useState(0);
  const gw = useMemo(() => acquireGatewayClient(), []);
  useEffect(() => () => releaseGatewayClient(gw), [gw]);
  const [state, dispatch] = useReducer(
    knowledgeChatReducer,
    initialKnowledgeChatState,
  );
  const stateRef = useRef(state);
  const lastDeltaAtRef = useRef(0);
  const reconcileInFlightRef = useRef(false);
  const reconcileUntilRef = useRef(0);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const messageCounter = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hydratedPromptRef = useRef(false);
  const initialResumeTargetRef = useRef(searchParams.get("session"));
  const openedDraftReferencesRef = useRef(new Set<string>());
  const [mode, setMode] = useState<WorkbenchMode>(isCaptureReviewRoute ? "draft_review" : "chat");
  const [selection, setSelection] = useState<WorkbenchSelection | null>(null);
  const [drafts, setDrafts] = useState<KnowledgeCaptureDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [draftDetail, setDraftDetail] = useState<KnowledgeCaptureDraft | null>(null);
  const [draftFilter, setDraftFilter] = useState<DraftFilterKey>("open");
  const [draftQuery, setDraftQuery] = useState("");
  const [draftView, setDraftView] = useState<DraftView>("draft");
  const [revision, setRevision] = useState("");
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftDetailLoading, setDraftDetailLoading] = useState(false);
  const [draftActionLoading, setDraftActionLoading] = useState<DraftActionLoading>(null);
  const [draftError, setDraftError] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  const [aiOperation, setAiOperation] = useState<AiOperationState>(null);
  const cancelledAiOperationsRef = useRef<Set<string>>(new Set());
  const [answerDrafts, setAnswerDrafts] = useState<KnowledgeReadingDraft[]>([]);
  const [answerDraftsLoading, setAnswerDraftsLoading] = useState(true);
  const [selectedAnswerDraftId, setSelectedAnswerDraftId] = useState("");
  const [answerDraftDetail, setAnswerDraftDetail] = useState<KnowledgeReadingDraft | null>(null);
  const [answerDraftLoading, setAnswerDraftLoading] = useState(false);
  const [answerDraftActionLoading, setAnswerDraftActionLoading] = useState<AnswerDraftActionLoading>(null);
  const [answerRevision, setAnswerRevision] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("sources");
  const [objectEvents, setObjectEvents] = useState<KnowledgeObjectEvent[]>([]);
  const [objectEventsLoading, setObjectEventsLoading] = useState(false);
  const [objectEventsError, setObjectEventsError] = useState("");
  const [objectEventsVersion, setObjectEventsVersion] = useState(0);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [resumingSessionId, setResumingSessionId] = useState("");
  const [editableContent, setEditableContent] = useState("");
  const [editableSource, setEditableSource] = useState("");
  const [editableTitle, setEditableTitle] = useState("");
  const [editableTitleSource, setEditableTitleSource] = useState<"ai" | "user">("ai");
  const [editableSummary, setEditableSummary] = useState("");
  const [editableTagsText, setEditableTagsText] = useState("");
  const [editableFolder, setEditableFolder] = useState("Inbox");
  const [editableFolderSuggestionMode, setEditableFolderSuggestionMode] = useState<"existing" | "new">("existing");
  const [editableFolderSuggestionReason, setEditableFolderSuggestionReason] = useState("");
  const [editableGenerateCard, setEditableGenerateCard] = useState(false);
  const [editableCardCommitStatus, setEditableCardCommitStatus] = useState<EditableCardCommitStatus>("idle");
  const [editableCardReason, setEditableCardReason] = useState("");
  const [editableCardSuggestionsText, setEditableCardSuggestionsText] = useState("");
  const [editableProgressMessage, setEditableProgressMessage] = useState("");
  const [editableDraft, setEditableDraft] = useState<KnowledgeCaptureDraft | null>(null);
  const [editableStatus, setEditableStatus] = useState<EditableCaptureStatus>("empty");
  const [editableError, setEditableError] = useState("");
  const [libraryFolders, setLibraryFolders] = useState<KnowledgeLibraryFolder[]>([]);
  // The developer inspector (tool calls / object events) is closed by default so
  // the page reads as a user-facing topic studio. The top-bar toggle still opens it.
  const [showInspector, setShowInspector] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredWidth(CHAT_SIDEBAR_WIDTH_KEY, DEFAULT_CHAT_SIDEBAR_WIDTH),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readStoredWidth(CHAT_INSPECTOR_WIDTH_KEY, DEFAULT_CHAT_INSPECTOR_WIDTH),
  );
  const chatLayoutRef = useRef<HTMLDivElement | null>(null);
  const chatLayoutStyle = {
    "--knowledge-chat-sidebar-width": `${sidebarWidth}px`,
    "--knowledge-chat-inspector-width": `${inspectorWidth}px`,
  } as CSSProperties;
  const [researchMode, setResearchMode] = useState<KnowledgeChatResearchMode>("local_web");
  const initialResearchModeRef = useRef(researchMode);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const nextId = useCallback((prefix: string) => {
    messageCounter.current += 1;
    return `${prefix}-${Date.now()}-${messageCounter.current}`;
  }, []);

  const visibleFolderPaths = useMemo(
    () => Array.from(new Set(["Inbox", ...libraryFolders.map((folder) => folder.path).filter(Boolean)])).slice(0, 80),
    [libraryFolders],
  );

  const beginAiOperation = useCallback((label: string) => {
    const operationId = createAiOperationId(label);
    const controller = new AbortController();
    cancelledAiOperationsRef.current.delete(operationId);
    setAiOperation({ id: operationId, label, controller, stopping: false });
    return {
      operationId,
      signal: controller.signal,
      isCancelled: () => controller.signal.aborted || cancelledAiOperationsRef.current.has(operationId),
      finish: () => {
        setAiOperation((current) => (current?.id === operationId ? null : current));
        cancelledAiOperationsRef.current.delete(operationId);
      },
    };
  }, []);

  const stopAiOperation = useCallback(() => {
    if (!aiOperation || aiOperation.stopping) return;
    cancelledAiOperationsRef.current.add(aiOperation.id);
    aiOperation.controller.abort();
    setAiOperation(null);
    setDraftNotice("已请求停止。你可以继续编辑或重试。");
    setEditableProgressMessage("已请求停止，可继续编辑或重试");
    setEditableStatus((current) => (
      current === "organizing" ? "editing" : current === "committing" ? "ready_to_commit" : current
    ));
    void api.cancelKnowledgeAiOperation(aiOperation.id).catch((error) => {
      setDraftError(error instanceof Error ? error.message : String(error));
    });
  }, [aiOperation]);

  const loadDrafts = useCallback(async (options?: { selectLatestOpen?: boolean }) => {
    setDraftsLoading(true);
    setDraftError("");
    try {
      const payload = await api.getKnowledgeCaptureDrafts(100);
      const visibleDrafts = payload.drafts.filter((draft) => !HIDDEN_DRAFT_STATUSES.has(draft.status));
      setDrafts(visibleDrafts);
      setSelectedDraftId((current) => {
        if (!options?.selectLatestOpen && current && visibleDrafts.some((draft) => draft.id === current)) {
          return current;
        }
        return visibleDrafts.find((draft) => OPEN_STATUSES.has(draft.status))?.id
          ?? visibleDrafts[0]?.id
          ?? "";
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftsLoading(false);
    }
  }, []);

  const loadLibraryFolders = useCallback(async () => {
    try {
      const payload = await api.getKnowledgeLibraryFolders();
      setLibraryFolders(payload.folders);
    } catch {
      setLibraryFolders([]);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const payload = await api.getSessions(20, 0);
      setSessions(payload.sessions);
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadDraftDetail = useCallback(async (draftId: string) => {
    if (!draftId) {
      setDraftDetail(null);
      return;
    }
    setDraftDetailLoading(true);
    setDraftError("");
    try {
      const payload = await api.getKnowledgeCaptureDraft(draftId);
      setDraftDetail(payload.draft);
      setRevision("");
      setDraftView(payload.draft.draft_text ? "draft" : "raw");
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftDetailLoading(false);
    }
  }, []);

  const selectDraft = useCallback((draftId: string) => {
    setSelectedDraftId(draftId);
    setSelection({ type: "draft", draftId });
    setMode("draft_review");
  }, []);

  const openAnswerDraft = useCallback(async (draftId: string) => {
    if (!draftId) return;
    setSelectedAnswerDraftId(draftId);
    setAnswerDraftLoading(true);
    setDraftError("");
    try {
      const payload = await api.getKnowledgeReadingDraft(draftId);
      setAnswerDraftDetail(payload.draft);
      setAnswerRevision("");
      setSelection({ type: "draft", draftId });
      setMode("answer_draft_review");
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftLoading(false);
    }
  }, []);

  const loadAnswerDrafts = useCallback(async () => {
    setAnswerDraftsLoading(true);
    setDraftError("");
    try {
      const payload = await api.getKnowledgeReadingDrafts(100);
      setAnswerDrafts(payload.drafts);
      setSelectedAnswerDraftId((current) => {
        if (current && payload.drafts.some((draft) => draft.id === current)) return current;
        return payload.drafts.find((draft) => draft.status === "open")?.id
          ?? payload.drafts[0]?.id
          ?? "";
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftsLoading(false);
    }
  }, []);

  const reconcileCurrentSession = useCallback(async (reason: string): Promise<boolean> => {
    void reason;
    const snapshot = stateRef.current;
    const sessionId = snapshot.sessionId;
    if (!sessionId || gw.state !== "open" || reconcileInFlightRef.current) return false;
    reconcileInFlightRef.current = true;
    try {
      const result = await gw.request<GatewayHistoryResponse>("session.history", {
        session_id: sessionId,
      });
      const hydrated = gatewayMessagesToWorkbench(result.messages ?? []);
      if (!shouldHydrateFromHistory(snapshot, hydrated.messages)) return false;
      dispatch({
        type: "hydrate_messages",
        messages: hydrated.messages,
        tools: hydrated.tools,
        toolSummaries: hydrated.toolSummaries,
      });
      return true;
    } catch {
      return false;
    } finally {
      reconcileInFlightRef.current = false;
    }
  }, [gw]);

  const scheduleHistoryReconcile = useCallback((reason: string, delayMs = 0) => {
    window.setTimeout(() => {
      void reconcileCurrentSession(reason);
    }, delayMs);
  }, [reconcileCurrentSession]);

  useEffect(() => {
    void loadDrafts();
    void loadAnswerDrafts();
    void loadLibraryFolders();
    void loadSessions();
  }, [loadAnswerDrafts, loadDrafts, loadLibraryFolders, loadSessions]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WORKBENCH_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as {
        messages?: KnowledgeMessage[];
        sessionId?: string;
        mode?: WorkbenchMode;
        selectedDraftId?: string;
        selection?: WorkbenchSelection | null;
      };
      if (cached.sessionId) {
        dispatch({ type: "session_created", sessionId: cached.sessionId });
      }
      if (Array.isArray(cached.messages) && cached.messages.length) {
        dispatch({ type: "hydrate_messages", messages: cached.messages });
      }
      if (cached.mode && !isCaptureReviewRoute) {
        setMode(cached.mode === "editable_capture" ? "chat" : cached.mode);
      }
      if (cached.selectedDraftId) setSelectedDraftId(cached.selectedDraftId);
      if (cached.selection) setSelection(cached.selection);
    } catch {
      window.localStorage.removeItem(WORKBENCH_CACHE_KEY);
    }
  }, [isCaptureReviewRoute]);

  useEffect(() => {
    if (isCaptureReviewRoute) setMode("draft_review");
  }, [isCaptureReviewRoute]);

  useEffect(() => {
    const messages = state.messages.slice(-80);
    if (!messages.length && !state.sessionId) return;
    window.localStorage.setItem(
      WORKBENCH_CACHE_KEY,
      JSON.stringify({
        messages,
        sessionId: state.sessionId,
        mode: mode === "editable_capture" ? "chat" : mode,
        selectedDraftId,
        selection,
        savedAt: Date.now(),
      }),
    );
  }, [mode, selectedDraftId, selection, state.messages, state.sessionId]);

  useEffect(() => {
    if (draftsLoading || answerDraftsLoading) return;
    const lastAssistant = [...state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const reference = resolveKnowledgeDraftReference(lastAssistant?.text ?? "", {
      captureDraftIds: drafts.map((draft) => draft.id),
      readingDraftIds: answerDrafts.map((draft) => draft.id),
    });
    if (!reference) return;
    const referenceKey = `${state.sessionId}:${reference.type}:${reference.id}`;
    if (openedDraftReferencesRef.current.has(referenceKey)) return;
    openedDraftReferencesRef.current.add(referenceKey);
    if (reference.type === "capture") {
      selectDraft(reference.id);
      return;
    }
    void openAnswerDraft(reference.id);
  }, [answerDrafts, answerDraftsLoading, drafts, draftsLoading, openAnswerDraft, selectDraft, state.messages, state.sessionId]);

  useEffect(() => {
    void loadDraftDetail(selectedDraftId);
  }, [loadDraftDetail, selectedDraftId]);

  useEffect(() => {
    const refreshWorkbench = () => {
      if (document.visibilityState === "hidden") return;
      void loadDrafts();
      void loadAnswerDrafts();
      void loadLibraryFolders();
      void loadSessions();
      if (stateRef.current.running || stateRef.current.draftAssistant) {
        scheduleHistoryReconcile("focus");
      }
      if (selectedDraftId) void loadDraftDetail(selectedDraftId);
    };
    window.addEventListener("focus", refreshWorkbench);
    document.addEventListener("visibilitychange", refreshWorkbench);
    return () => {
      window.removeEventListener("focus", refreshWorkbench);
      document.removeEventListener("visibilitychange", refreshWorkbench);
    };
  }, [loadAnswerDrafts, loadDraftDetail, loadDrafts, loadLibraryFolders, loadSessions, scheduleHistoryReconcile, selectedDraftId]);

  useEffect(() => {
    if (version > 0) gw.close();
    const offState = gw.onState((connection) => {
      dispatch({ type: "connection", connection });
      if (connection === "open" && (stateRef.current.running || stateRef.current.draftAssistant)) {
        scheduleHistoryReconcile("gateway-open");
      }
    });

    const offStart = gw.on("message.start", () => {
      dispatch({
        type: "message_start",
        id: nextId("assistant"),
        createdAt: Date.now(),
      });
    });

    const offDelta = gw.on<MessageDeltaPayload>("message.delta", (ev) => {
      if (ev.payload?.text) {
        lastDeltaAtRef.current = Date.now();
        dispatch({ type: "message_delta", text: ev.payload.text });
      }
    });

    const offComplete = gw.on<MessageCompletePayload>("message.complete", (ev) => {
      const text = ev.payload?.text ?? "";
      dispatch({
        type: "message_complete",
        id: nextId("assistant"),
        text,
        createdAt: Date.now(),
        warning: ev.payload?.warning,
      });
      void loadDrafts({ selectLatestOpen: true });
      void loadAnswerDrafts();
      void loadSessions();
      scheduleHistoryReconcile("message-complete", 250);
    });

    const offToolStart = gw.on<ToolStartPayload>("tool.start", (ev) => {
      const toolId = ev.payload?.tool_id;
      if (!toolId) return;
      dispatch({
        type: "tool_start",
        toolId,
        name: ev.payload?.name ?? "tool",
        context: ev.payload?.context,
      });
    });

    const offToolProgress = gw.on<ToolProgressPayload>("tool.progress", (ev) => {
      const preview = ev.payload?.preview;
      if (!preview) return;
      dispatch({
        type: "tool_progress",
        toolId: ev.payload?.tool_id,
        name: ev.payload?.name,
        preview,
        stage: ev.payload?.stage,
        status: ev.payload?.status,
      });
    });

    const offToolComplete = gw.on<ToolCompletePayload>("tool.complete", (ev) => {
      const toolId = ev.payload?.tool_id;
      if (!toolId) return;
      const toolName = ev.payload?.name ?? "";
      dispatch({
        type: "tool_complete",
        toolId,
        summary: ev.payload?.summary,
        error: ev.payload?.error,
        inlineDiff: ev.payload?.inline_diff,
        answerText: ev.payload?.answer_text,
        knowledgeSources: ev.payload?.knowledge_sources,
        sourceMap: ev.payload?.source_map,
        webSources: ev.payload?.web_sources,
        retrievedWebSources: ev.payload?.retrieved_web_sources,
        searchBackend: searchBackendFromTrace(ev.payload?.research_trace),
      });
      if (/capture|draft/i.test(toolName)) {
        void loadDrafts();
        void loadAnswerDrafts();
      }
    });

    const offError = gw.on<ErrorPayload>("error", (ev) => {
      void reconcileCurrentSession("gateway-error").then((recovered) => {
        if (recovered) return;
        dispatch({
          type: "error",
          message: ev.payload?.message ?? "Hermes returned an unknown error.",
        });
      });
    });

    let cancelled = false;

    gw.connect()
      .then(async () => {
        const target =
          initialResumeTargetRef.current ||
          window.localStorage.getItem(WORKBENCH_LAST_SESSION_KEY) ||
          "";
        if (target) {
          try {
            return await gw.request<GatewayResumeResponse>("session.resume", {
              session_id: target,
              enabled_toolsets: knowledgeToolsetsForMode(initialResearchModeRef.current),
            });
          } catch {
            window.localStorage.removeItem(WORKBENCH_LAST_SESSION_KEY);
          }
        }
        return gw.request<{ session_id: string }>("session.create", {
          enabled_toolsets: knowledgeToolsetsForMode(initialResearchModeRef.current),
        });
      })
      .then((created) => {
        if (cancelled || !created.session_id) return;
        dispatch({ type: "session_created", sessionId: created.session_id });
        window.localStorage.setItem(WORKBENCH_LAST_SESSION_KEY, created.session_id);
        const resumed = (created as GatewayResumeResponse).resumed;
        const messages = (created as GatewayResumeResponse).messages;
        if (resumed) {
          setSelection({ type: "conversation", sessionId: resumed });
          window.localStorage.setItem(WORKBENCH_LAST_SESSION_KEY, resumed);
        }
        if (Array.isArray(messages)) {
          const hydrated = gatewayMessagesToWorkbench(messages);
          dispatch({
            type: "hydrate_messages",
            messages: hydrated.messages,
            tools: hydrated.tools,
            toolSummaries: hydrated.toolSummaries,
          });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          dispatch({ type: "error", message: error.message });
        }
      });

    return () => {
      cancelled = true;
      offState();
      offStart();
      offDelta();
      offComplete();
      offToolStart();
      offToolProgress();
      offToolComplete();
      offError();
    };
  }, [gw, version, loadAnswerDrafts, loadDrafts, loadSessions, nextId, reconcileCurrentSession, scheduleHistoryReconcile]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [state.messages, state.draftAssistant?.text]);

  useEffect(() => {
    if (!state.sessionId || (!state.running && !state.draftAssistant)) return;
    if (!reconcileUntilRef.current) {
      reconcileUntilRef.current = Date.now() + HISTORY_RECONCILE_MAX_MS;
    }
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (now > reconcileUntilRef.current) return;
      if (lastDeltaAtRef.current && now - lastDeltaAtRef.current < HISTORY_RECONCILE_IDLE_MS) return;
      void reconcileCurrentSession("idle-stream");
    }, HISTORY_RECONCILE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [reconcileCurrentSession, state.draftAssistant, state.running, state.sessionId]);

  useEffect(() => {
    if (hydratedPromptRef.current) return;
    const prompt = searchParams.get("prompt");
    if (!prompt) return;
    hydratedPromptRef.current = true;
    setInput(prompt);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("prompt");
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const draftId = searchParams.get("answerDraft");
    if (!draftId) return;
    void openAnswerDraft(draftId);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("answerDraft");
      return next;
    }, { replace: true });
  }, [openAnswerDraft, searchParams, setSearchParams]);

  const canSend =
    state.connection === "open" &&
    Boolean(state.sessionId) &&
    !state.running &&
    !uploading &&
    (input.trim().length > 0 || attachments.length > 0);

  const commitDraftById = useCallback(async (draftId: string, title?: string): Promise<boolean> => {
    if (!draftId) return false;
    const operation = beginAiOperation("capture-commit");
    setDraftActionLoading("commit");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.commitKnowledgeCaptureDraft(draftId, { operationId: operation.operationId });
      if (isAiCancelledResult(result)) {
        setDraftNotice("已停止。草稿仍保留，可继续修改或重试保存。");
        return false;
      }
      setDraftNotice(title ? `已保存到资料库：《${title}》。` : "已保存到资料库，草稿状态已刷新。");
      await loadDrafts();
      await loadDraftDetail(draftId);
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setDraftActionLoading(null);
      operation.finish();
    }
  }, [beginAiOperation, loadDraftDetail, loadDrafts]);

  const deleteDraftById = useCallback(async (draftId: string, title?: string): Promise<boolean> => {
    if (!draftId) return false;
    setDraftActionLoading("delete");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.deleteKnowledgeCaptureDraft(draftId);
      setDraftNotice(title ? `已删除草稿：《${title}》。` : "已删除草稿。");
      const payload = await api.getKnowledgeCaptureDrafts(100);
      const visibleDrafts = payload.drafts.filter((draft) => !HIDDEN_DRAFT_STATUSES.has(draft.status));
      setDrafts(visibleDrafts);
      const nextDraftId = visibleDrafts.find(
        (draft) => draft.id !== draftId && OPEN_STATUSES.has(draft.status),
      )?.id ?? "";
      setDraftDetail(null);
      setRevision("");
      setSelectedDraftId(nextDraftId);
      if (nextDraftId) {
        setSelection({ type: "draft", draftId: nextDraftId });
        setMode("draft_review");
        await loadDraftDetail(nextDraftId);
      } else {
        setSelection(null);
        setMode("chat");
      }
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setDraftActionLoading(null);
    }
  }, [loadDraftDetail]);

  const createAnswerDraft = useCallback(async (
    message: KnowledgeMessage,
    outputType: AnswerOutputType,
  ) => {
    if (!state.sessionId || message.role !== "assistant" || !message.text.trim()) return;
    const messageIndex = state.messages.findIndex((item) => item.id === message.id);
    const previousUser = [...state.messages.slice(0, messageIndex)]
      .reverse()
      .find((item) => item.role === "user");
    const sourceHints = message.sourceHints ?? [];

    const operation = beginAiOperation("answer-draft");
    setAnswerDraftActionLoading("create");
    setAnswerDraftLoading(true);
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.createKnowledgeAnswerDraft({
        hermes_session_id: state.sessionId,
        user_message: previousUser?.text ?? "",
        assistant_answer: message.text,
        instruction: outputType === "knowledge_card" ? "做成知识卡片" : "存为知识",
        output_type: outputType,
        assistant_message_id: message.id,
        sources: sourceHints.map((source) => ({
          type: source.sourceType || source.origin,
          id: source.sourceId || source.id,
          title: source.label,
          label: source.ref || source.label,
          url: source.url,
          excerpt: source.excerpt,
          file_path: source.filePath,
          item_id: source.itemId,
          item_kind: source.itemKind,
          file_url: source.fileUrl,
          open_url: source.openUrl,
          path: source.path || source.filePath,
        })),
        answer_source: sourceHints.length ? "latest_rag_full_answer" : "provided",
      }, { operationId: operation.operationId });
      if (isAiCancelledResult(result)) {
        setDraftNotice("已停止。回答沉淀草稿未生成。");
        return;
      }
      const draftId =
        typeof result.meta?.reading_draft_id === "string"
          ? result.meta.reading_draft_id
          : "";
      setDraftNotice(result.chat_preview || result.USER_VISIBLE_REPLY || "已生成回答沉淀草稿。");
      if (draftId) {
        const payload = await api.getKnowledgeReadingDraft(draftId);
        setAnswerDraftDetail(payload.draft);
        setSelectedAnswerDraftId(draftId);
        setSelection({ type: "draft", draftId });
        setMode("answer_draft_review");
        void loadAnswerDrafts();
      }
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftActionLoading(null);
      setAnswerDraftLoading(false);
      operation.finish();
    }
  }, [beginAiOperation, loadAnswerDrafts, state.messages, state.sessionId]);

  const commitAnswerDraft = useCallback(async () => {
    if (!answerDraftDetail) return;
    const operation = beginAiOperation("reading-commit");
    setAnswerDraftActionLoading("commit");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.commitKnowledgeReadingDraft(answerDraftDetail.id, { operationId: operation.operationId });
      if (isAiCancelledResult(result)) {
        setDraftNotice("已停止。草稿仍保留，可继续修改或重试保存。");
        return;
      }
      setDraftNotice(`已保存：《${answerDraftDetail.title || "回答沉淀草稿"}》。`);
      const payload = await api.getKnowledgeReadingDraft(answerDraftDetail.id);
      setAnswerDraftDetail(payload.draft);
      await loadAnswerDrafts();
      await loadDrafts();
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftActionLoading(null);
      operation.finish();
    }
  }, [answerDraftDetail, beginAiOperation, loadAnswerDrafts, loadDrafts]);

  const reviseAnswerDraft = useCallback(async () => {
    if (!answerDraftDetail || !answerRevision.trim()) return;
    const operation = beginAiOperation("reading-revise");
    setAnswerDraftActionLoading("revise");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.reviseKnowledgeReadingDraft(
        answerDraftDetail.id,
        answerRevision.trim(),
        { operationId: operation.operationId },
      );
      if (isAiCancelledResult(result)) {
        setDraftNotice("已停止。草稿内容未被覆盖。");
        return;
      }
      setDraftNotice("已修改文稿草稿，正在刷新。");
      const payload = await api.getKnowledgeReadingDraft(answerDraftDetail.id);
      setAnswerDraftDetail(payload.draft);
      setAnswerRevision("");
      await loadAnswerDrafts();
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftActionLoading(null);
      operation.finish();
    }
  }, [answerDraftDetail, answerRevision, beginAiOperation, loadAnswerDrafts]);

  const convertAnswerDraftToCard = useCallback(async () => {
    if (!answerDraftDetail) return;
    const captureId = readingDraftCaptureId(answerDraftDetail);
    if (answerDraftDetail.output_type !== "local_learning_note" || answerDraftDetail.status !== "committed" || !captureId) {
      setDraftError("只有已保存的资料笔记可以转换成知识卡片。");
      return;
    }
    const operation = beginAiOperation("reading-card");
    setAnswerDraftActionLoading("card");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.createKnowledgeGardenDraft(
        { capture_ids: [captureId] },
        { operationId: operation.operationId },
      );
      if (isAiCancelledResult(result)) {
        setDraftNotice("已停止。知识卡片未生成。");
        return;
      }
      if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
        throw new Error(gardenDraftError(result));
      }
      setDraftNotice(gardenDraftNotice(result));
      setObjectEventsVersion((current) => current + 1);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftActionLoading(null);
      operation.finish();
    }
  }, [answerDraftDetail, beginAiOperation]);

  const deleteAnswerDraftById = useCallback(async (draftId: string, title?: string): Promise<boolean> => {
    if (!draftId) return false;
    setAnswerDraftActionLoading("delete");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.deleteKnowledgeReadingDraft(draftId);
      setDraftNotice(title ? `已删除草稿：《${title}》。` : "已删除草稿。");
      const payload = await api.getKnowledgeReadingDrafts(100);
      setAnswerDrafts(payload.drafts);
      const nextDraftId = payload.drafts.find(
        (draft) => draft.id !== draftId && draft.status === "open",
      )?.id ?? "";
      setAnswerDraftDetail(null);
      setAnswerRevision("");
      setSelectedAnswerDraftId(nextDraftId);
      if (nextDraftId) {
        await openAnswerDraft(nextDraftId);
      } else {
        setSelection(null);
        setMode("chat");
      }
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setAnswerDraftActionLoading(null);
    }
  }, [openAnswerDraft]);

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;

    setUploading(true);
    dispatch({ type: "reset_error" });
    try {
      const uploaded: ComposerAttachment[] = [];
      for (const file of list) {
        const contentBase64 = await fileToBase64(file);
        const result = await api.uploadDashboardFile({
          name: file.name,
          mime_type: file.type,
          content_base64: contentBase64,
        });
        uploaded.push({
          id: `${result.path}-${Date.now()}-${uploaded.length}`,
          name: result.name,
          path: result.path,
          mimeType: result.mime_type || file.type,
          size: result.size,
          kind: isImageFile(result.name, result.mime_type || file.type) ? "image" : "file",
        });
      }
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDraftCommand = useCallback(async (text: string): Promise<boolean> => {
    if (!isCommitDraftCommand(text)) return false;

    const openDrafts = drafts.filter((draft) => OPEN_STATUSES.has(draft.status) && !isCommittedCaptureDraft(draft));
    const selectedOpenDraft = openDrafts.find((draft) => draft.id === selectedDraftId);
    const target = selectedOpenDraft ?? (openDrafts.length === 1 ? openDrafts[0] : null);

    if (!target) {
      setDraftError(
        openDrafts.length > 1
          ? "现在有多个待审草稿，请先在左侧选择要保存的草稿，或进入草稿审阅页点击“保存到资料库”。"
          : "当前没有待审草稿可以保存。",
      );
      return true;
    }

    dispatch({
      type: "submit_user",
      id: nextId("user"),
      text,
      createdAt: Date.now(),
    });
    const committed = await commitDraftById(target.id, target.title);
    const assistantText = committed
      ? `已保存到资料库：《${target.title || "未命名草稿"}》。`
      : `保存失败：《${target.title || "未命名草稿"}》。请查看上方错误提示。`;
    dispatch({
      type: "message_complete",
      id: nextId("assistant"),
      text: assistantText,
      createdAt: Date.now(),
    });
    setSelectedDraftId(target.id);
    if (state.sessionId) {
      try {
        await gw.request<GatewayAppendLocalMessagesResponse>("session.append_local_messages", {
          session_id: state.sessionId,
          messages: [
            { role: "user", text },
            { role: "assistant", text: assistantText },
          ],
        });
        void loadSessions();
      } catch {
        // Keep the visible confirmation even if session-history persistence fails.
      }
    }
    return true;
  }, [commitDraftById, drafts, gw, loadSessions, nextId, selectedDraftId, state.sessionId]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!canSend || !state.sessionId) return;

    if (!attachments.length && (await handleDraftCommand(text))) {
      setInput("");
      return;
    }

    const selectedAttachments = attachments;
    const visibleText = buildVisibleUserText(text, selectedAttachments);
    const basePrompt = buildPromptText(text || "请处理我上传的附件。", selectedAttachments);
    const finalText = withResearchModeInstruction(basePrompt, researchMode);

    try {
      await gw.request("session.set_toolsets", {
        session_id: state.sessionId,
        enabled_toolsets: knowledgeToolsetsForMode(researchMode),
      });
      for (const attachment of selectedAttachments) {
        if (attachment.kind === "image") {
          await gw.request("image.attach", {
            session_id: state.sessionId,
            path: attachment.path,
          });
        }
      }
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    dispatch({
      type: "submit_user",
      id: nextId("user"),
      text: visibleText,
      createdAt: Date.now(),
    });
    lastDeltaAtRef.current = Date.now();
    reconcileUntilRef.current = Date.now() + HISTORY_RECONCILE_MAX_MS;
    setInput("");
    setAttachments([]);

    gw.request(
      "prompt.submit",
      { session_id: state.sessionId, text: finalText },
      PROMPT_SUBMIT_TIMEOUT_MS,
    )
      .then(() => {
        scheduleHistoryReconcile("prompt-submit-resolved", 250);
      })
      .catch(async (error: Error) => {
        const recovered = await reconcileCurrentSession("prompt-submit-error");
        if (!recovered) {
          dispatch({ type: "error", message: error.message });
        }
      });
  }, [attachments, canSend, gw, handleDraftCommand, input, nextId, reconcileCurrentSession, researchMode, scheduleHistoryReconcile, state.sessionId]);

  const stopGeneration = useCallback(() => {
    if (!state.sessionId || !state.running || state.interruptRequested) return;
    dispatch({ type: "interrupt_requested" });
    gw.request("session.interrupt", { session_id: state.sessionId }, 10_000)
      .then(() => {
        void loadDrafts({ selectLatestOpen: true });
        scheduleHistoryReconcile("manual-interrupt", 250);
      })
      .catch((error: Error) => {
        dispatch({ type: "error", message: error.message });
      });
  }, [gw, loadDrafts, scheduleHistoryReconcile, state.interruptRequested, state.running, state.sessionId]);

  const reconnect = useCallback(() => {
    dispatch({ type: "reset_error" });
    setVersion((value) => value + 1);
  }, []);

  const startNewSession = useCallback(async () => {
    if (state.connection !== "open") return;
    setResumingSessionId("new");
    try {
      const created = await gw.request<{ session_id: string }>("session.create", {
        enabled_toolsets: knowledgeToolsetsForMode(researchMode),
      });
      dispatch({ type: "session_created", sessionId: created.session_id });
      dispatch({ type: "clear_messages" });
      setSelection(null);
      setMode("chat");
      window.localStorage.removeItem(WORKBENCH_LAST_SESSION_KEY);
      window.localStorage.removeItem(WORKBENCH_CACHE_KEY);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("session");
        return next;
      }, { replace: true });
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResumingSessionId("");
    }
  }, [gw, researchMode, setSearchParams, state.connection]);

  const resumeSession = useCallback(async (sessionId: string) => {
    if (state.connection !== "open") return;
    setResumingSessionId(sessionId);
    try {
      const result = await gw.request<GatewayResumeResponse>("session.resume", {
        session_id: sessionId,
        enabled_toolsets: knowledgeToolsetsForMode(researchMode),
      });
      dispatch({ type: "session_created", sessionId: result.session_id });
      const hydrated = gatewayMessagesToWorkbench(result.messages ?? []);
      dispatch({
        type: "hydrate_messages",
        messages: hydrated.messages,
        tools: hydrated.tools,
        toolSummaries: hydrated.toolSummaries,
      });
      const restoredId = result.resumed || sessionId;
      setSelection({ type: "conversation", sessionId: restoredId });
      setMode("chat");
      window.localStorage.setItem(WORKBENCH_LAST_SESSION_KEY, restoredId);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set("session", restoredId);
        return next;
      }, { replace: true });
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResumingSessionId("");
    }
  }, [gw, researchMode, setSearchParams, state.connection]);

  const applyEditableDraftSuggestion = useCallback((draft: KnowledgeCaptureDraft, options: {
    fallbackContent?: string;
    fallbackFolder?: string;
  } = {}) => {
    const folderSuggestion = editableFolderSuggestion(draft.capture_intent);
    const cardSuggestion = editableCardSuggestion(draft.capture_intent);
    const folderPath = folderSuggestion.folder_path || options.fallbackFolder || "Inbox";
    setEditableDraft(draft);
    setEditableContent(draft.draft_text || options.fallbackContent || "");
    setEditableTitle(draft.title || "");
    setEditableTitleSource(editableDraftTitleSource(draft));
    setEditableSummary(draft.summary || "");
    setEditableTagsText((draft.tags || []).join(", "));
    setEditableFolder(folderPath);
    setEditableFolderSuggestionMode(folderSuggestion.mode);
    setEditableFolderSuggestionReason(folderSuggestion.reason);
    setEditableGenerateCard(cardSuggestion.should_generate);
    setEditableCardReason(cardSuggestion.reason);
    setEditableCardSuggestionsText(formatEditableCardSuggestions(cardSuggestion.cards));
  }, []);

  const ensureEditableFolder = useCallback(async (folderPath: string) => {
    const target = folderPath.trim() || "Inbox";
    if (!target || target === "Inbox") return target;
    if (libraryFolders.some((folder) => folder.path === target)) return target;
    const payload = await api.createKnowledgeLibraryFolder(target);
    await loadLibraryFolders();
    return payload.folder.path || target;
  }, [libraryFolders, loadLibraryFolders]);

  const maybeGenerateGardenCardAfterCommit = useCallback(async ({
    draft,
    commitResult,
    shouldGenerate,
    reason,
    suggestionsText,
    onStage,
    operationId,
  }: {
    draft: KnowledgeCaptureDraft;
    commitResult: Record<string, unknown>;
    shouldGenerate: boolean;
    reason: string;
    suggestionsText: string;
    onStage?: (message: string) => void;
    operationId?: string;
  }): Promise<{ generated: boolean; error?: string }> => {
    if (!shouldGenerate) return { generated: false };
    const captureId = (
      bridgeMetaString(commitResult, "capture_id")
      || bridgeMetaString(commitResult, "committed_capture_id")
      || draft.committed_capture_id
    );
    if (!captureId) {
      return { generated: false, error: "保存成功，但没有拿到 Capture ID。" };
    }
    try {
      onStage?.("正在生成知识卡片...");
      const cardHint = firstGardenCardHint(suggestionsText);
      const result = await api.createKnowledgeGardenDraft({
        capture_ids: [captureId],
        title: cardHint.title,
        card_kind: cardHint.card_kind,
        instruction: buildGardenDraftInstruction(reason, suggestionsText),
      }, operationId ? { operationId } : undefined);
      if (isAiCancelledResult(result)) {
        return { generated: false, error: "已停止。" };
      }
      if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
        throw new Error(gardenDraftError(result));
      }
      return { generated: true };
    } catch (error) {
      return {
        generated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, []);

  const saveEditableCaptureDraftSnapshot = useCallback(async (
    options: { folderPath?: string } = {},
  ): Promise<KnowledgeCaptureDraft | null> => {
    const content = editableContent.trim();
    if (!content) return null;
    const folderPath = options.folderPath ?? editableFolder;
    setEditableStatus("saving_draft");
    setEditableProgressMessage("正在保存当前修改...");
    setEditableError("");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = editableDraft?.id
          ? await api.updateKnowledgeEditableCaptureDraft(editableDraft.id, {
            content,
            title: editableTitle,
            title_source: editableTitleSource,
            summary: editableSummary,
            tags: parseTagsText(editableTagsText),
            folder_path: folderPath,
            folder_suggestion: {
              mode: editableFolderSuggestionMode,
              folder_path: folderPath,
              reason: editableFolderSuggestionReason,
            },
            card_suggestion: {
              should_generate: editableGenerateCard,
              reason: editableCardReason,
              cards: parseCardSuggestionsText(editableCardSuggestionsText),
            },
            organize: false,
            existing_folders: visibleFolderPaths,
          })
        : await api.createKnowledgeEditableCaptureDraft({
            content,
            source: editableSource,
            source_type: "manual",
            title: editableTitle,
            title_source: editableTitleSource,
            folder_path: folderPath,
            organize: false,
            existing_folders: visibleFolderPaths,
          });
      const draftId = bridgeMetaString(result, "draft_id") || editableDraft?.id || "";
      if (!draftId) throw new Error("没有返回草稿编号。");
      const payload = await api.getKnowledgeCaptureDraft(draftId);
      applyEditableDraftSuggestion(payload.draft, {
        fallbackContent: content,
        fallbackFolder: folderPath,
      });
      setSelectedDraftId(draftId);
      setSelection({ type: "draft", draftId });
      setEditableStatus("ready_to_commit");
      setEditableProgressMessage("已保存当前修改");
      setDraftNotice("已保存草稿。");
      await loadDrafts();
      return payload.draft;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEditableError(message);
      setEditableStatus("error");
      setEditableProgressMessage("");
      return null;
    }
  }, [
    applyEditableDraftSuggestion,
    editableCardReason,
    editableCardSuggestionsText,
    editableContent,
    editableDraft,
    editableFolder,
    editableFolderSuggestionMode,
    editableFolderSuggestionReason,
    editableGenerateCard,
    editableSource,
    editableSummary,
    editableTagsText,
    editableTitle,
    editableTitleSource,
    loadDrafts,
    visibleFolderPaths,
  ]);

  const organizeEditableCaptureDraft = useCallback(async (): Promise<KnowledgeCaptureDraft | null> => {
    const content = editableContent.trim();
    if (!content) return null;
    const operation = beginAiOperation("editable-organize");
    setEditableStatus("organizing");
    setEditableCardCommitStatus("idle");
    setEditableProgressMessage("正在生成 AI 建议...");
    setEditableError("");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = editableDraft?.id
          ? await api.updateKnowledgeEditableCaptureDraft(editableDraft.id, {
            content,
            title: editableTitle,
            title_source: editableTitleSource,
            folder_path: editableFolder,
            organize: true,
            existing_folders: visibleFolderPaths,
          }, { operationId: operation.operationId, signal: operation.signal })
        : await api.createKnowledgeEditableCaptureDraft({
            content,
            source: editableSource,
            source_type: "manual",
            title: editableTitle,
            title_source: editableTitleSource,
            folder_path: editableFolder,
            organize: true,
            existing_folders: visibleFolderPaths,
          }, { operationId: operation.operationId, signal: operation.signal });
      if (operation.isCancelled() || isAiCancelledResult(result)) {
        setEditableStatus("editing");
        setEditableProgressMessage("已停止，正文未被 AI 建议覆盖");
        setDraftNotice("已停止。你可以继续编辑或重新生成 AI 建议。");
        return null;
      }
      const draftId = bridgeMetaString(result, "draft_id") || editableDraft?.id || "";
      if (!draftId) throw new Error("没有返回草稿编号。");
      const payload = await api.getKnowledgeCaptureDraft(draftId);
      if (operation.isCancelled()) return null;
      applyEditableDraftSuggestion(payload.draft, {
        fallbackContent: content,
        fallbackFolder: editableFolder,
      });
      setSelectedDraftId(draftId);
      setSelection({ type: "draft", draftId });
      if (editableAiSuggestionsStatus(payload.draft) === "failed") {
        setEditableStatus("editing");
        setEditableProgressMessage("AI 建议生成失败，可手动填写或重试");
        setDraftNotice("AI 建议生成失败，正文已保存为草稿。");
        await loadDrafts();
        return payload.draft;
      }
      setEditableStatus("ready_to_commit");
      setEditableProgressMessage("整理完成，可以保存");
      setDraftNotice("已生成 AI 建议，可以继续编辑或保存。");
      await loadDrafts();
      return payload.draft;
    } catch (error) {
      if (operation.isCancelled() || isAbortError(error)) {
        setEditableStatus("editing");
        setEditableProgressMessage("已请求停止，可继续编辑或重试");
        setDraftNotice("已请求停止。你可以继续编辑或重新生成 AI 建议。");
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      setEditableError(message);
      setEditableStatus("error");
      setEditableProgressMessage("");
      return null;
    } finally {
      operation.finish();
    }
  }, [
    applyEditableDraftSuggestion,
    beginAiOperation,
    editableContent,
    editableDraft,
    editableFolder,
    editableSource,
    editableTitle,
    editableTitleSource,
    loadDrafts,
    visibleFolderPaths,
  ]);

  const commitEditableCaptureDraft = useCallback(async () => {
    const operation = beginAiOperation("editable-commit");
    setEditableStatus("committing");
    setEditableCardCommitStatus("idle");
    setEditableProgressMessage("正在保存当前修改...");
    setEditableError("");
    setDraftError("");
    setDraftNotice("");
    try {
      const targetFolder = await ensureEditableFolder(editableFolder);
      if (operation.isCancelled()) return;
      if (targetFolder !== editableFolder) setEditableFolder(targetFolder);
      const draft = await saveEditableCaptureDraftSnapshot({ folderPath: targetFolder });
      if (operation.isCancelled()) return;
      if (!draft) return;
      setEditableStatus("committing");
      setEditableProgressMessage("正在写入资料库文件...");
      const commitResult = await api.commitKnowledgeCaptureDraft(draft.id, {
        operationId: operation.operationId,
        signal: operation.signal,
      });
      if (operation.isCancelled() || isAiCancelledResult(commitResult)) {
        setEditableStatus("ready_to_commit");
        setEditableProgressMessage("已停止，草稿仍保留");
        setDraftNotice("已停止。草稿仍保留，可继续编辑或重试保存。");
        return;
      }
      setEditableProgressMessage("正在重建索引和大纲...");
      const payload = await api.getKnowledgeCaptureDraft(draft.id);
      if (operation.isCancelled()) return;
      applyEditableDraftSuggestion(payload.draft, {
        fallbackContent: "",
        fallbackFolder: targetFolder,
      });
      setDraftDetail(payload.draft);
      setSelectedDraftId(draft.id);
      setSelection({ type: "draft", draftId: draft.id });
      setEditableCardCommitStatus(editableGenerateCard ? "generating" : "skipped");
      const cardResult = await maybeGenerateGardenCardAfterCommit({
        draft: payload.draft,
        commitResult,
        shouldGenerate: editableGenerateCard,
        reason: editableCardReason,
        suggestionsText: editableCardSuggestionsText,
        onStage: setEditableProgressMessage,
        operationId: operation.operationId,
      });
      if (operation.isCancelled()) return;
      setEditableStatus("committed");
      setEditableCardCommitStatus(cardResult.generated ? "generated" : cardResult.error ? "failed" : "skipped");
      setEditableProgressMessage("保存完成");
      if (cardResult.generated) {
        setDraftNotice(`已保存并生成知识卡片：《${payload.draft.title || "未命名草稿"}》。`);
      } else if (cardResult.error) {
        setDraftNotice(`已保存，但知识卡片生成失败：${cardResult.error}`);
      } else {
        setDraftNotice(`已保存到资料库：《${payload.draft.title || "未命名草稿"}》。`);
      }
      await loadDrafts();
    } catch (error) {
      if (operation.isCancelled() || isAbortError(error)) {
        setEditableStatus("ready_to_commit");
        setEditableProgressMessage("已请求停止，可继续编辑或重试");
        setDraftNotice("已请求停止。草稿仍保留，可继续编辑或重试保存。");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setEditableError(message);
      setEditableStatus("error");
      setEditableProgressMessage("");
    } finally {
      operation.finish();
    }
  }, [
    applyEditableDraftSuggestion,
    beginAiOperation,
    editableCardReason,
    editableCardSuggestionsText,
    editableFolder,
    editableGenerateCard,
    ensureEditableFolder,
    loadDrafts,
    maybeGenerateGardenCardAfterCommit,
    saveEditableCaptureDraftSnapshot,
  ]);

  const filteredDrafts = useMemo(() => {
    const text = draftQuery.trim().toLowerCase();
    return drafts.filter((draft) => {
      if (HIDDEN_DRAFT_STATUSES.has(draft.status)) return false;
      if (draftFilter === "open" && (!OPEN_STATUSES.has(draft.status) || isCommittedCaptureDraft(draft))) return false;
      if (draftFilter === "committed" && !isCommittedCaptureDraft(draft)) return false;
      if (!text) return true;
      return [
        draft.title,
        draft.summary,
        draft.instruction,
        draft.source,
        draft.user_intent,
      ]
        .join("\n")
        .toLowerCase()
        .includes(text);
    });
  }, [draftFilter, draftQuery, drafts]);

  const filteredAnswerDrafts = useMemo(() => {
    const text = draftQuery.trim().toLowerCase();
    return answerDrafts.filter((draft) => {
      if (HIDDEN_DRAFT_STATUSES.has(draft.status)) return false;
      if (draftFilter === "open" && draft.status !== "open") return false;
      if (draftFilter === "committed" && draft.status !== "committed") return false;
      if (!text) return true;
      return [
        draft.title,
        draft.summary,
        draft.output_type,
        draft.draft_preview,
      ]
        .join("\n")
        .toLowerCase()
        .includes(text);
    });
  }, [answerDrafts, draftFilter, draftQuery]);

  const openCount = drafts.filter((draft) => OPEN_STATUSES.has(draft.status) && !isCommittedCaptureDraft(draft)).length;
  const latestOpenDraft = drafts.find((draft) => OPEN_STATUSES.has(draft.status) && !isCommittedCaptureDraft(draft));
  const inspectorObjectRef = useMemo<InspectorObjectRef>(() => {
    if (mode === "answer_draft_review" && answerDraftDetail?.id) {
      return {
        type: "reading_draft",
        id: answerDraftDetail.id,
        label: answerDraftDetail.title || "资料笔记",
      };
    }
    if (mode === "draft_review" && draftDetail?.id) {
      return {
        type: "capture_draft",
        id: draftDetail.id,
        label: draftDetail.title || "材料草稿",
      };
    }
    if (mode === "editable_capture" && editableDraft?.id) {
      return {
        type: "capture_draft",
        id: editableDraft.id,
        label: editableDraft.title || "知识文件草稿",
      };
    }
    return null;
  }, [answerDraftDetail, draftDetail, editableDraft, mode]);
  const inspectorSourceHints = useMemo(() => {
    if (mode === "answer_draft_review" && answerDraftDetail) {
      const text = answerDraftDetail.draft_text || answerDraftDetail.draft_preview || "";
      const parsed = extractSourceHints(text, []);
      return parsed.length ? parsed : sourceHintsFromMetaSources(answerDraftDetail);
    }
    if (mode === "draft_review" && draftDetail) {
      return sourceHintsFromCaptureDraft(draftDetail);
    }
    if (mode === "editable_capture" && editableDraft) {
      return sourceHintsFromCaptureDraft(editableDraft);
    }
    return state.sourceHints;
  }, [answerDraftDetail, draftDetail, editableDraft, mode, state.sourceHints]);
  const sourceEmptyText =
    mode === "answer_draft_review"
      ? "当前资料笔记没有可识别的引用来源。"
      : mode === "draft_review" || mode === "editable_capture"
        ? "当前材料没有额外引用来源。"
        : "当前回答还没有可识别的来源。RAG 工具返回引用时会在这里集中展示。";
  const isObjectInspectorMode =
    mode === "answer_draft_review" || mode === "draft_review" || mode === "editable_capture";
  const inspectorTools = useMemo(() => {
    if (isObjectInspectorMode) {
      return inspectorObjectRef ? objectEvents.map(objectEventToToolEntry) : [];
    }
    return state.tools;
  }, [inspectorObjectRef, isObjectInspectorMode, objectEvents, state.tools]);
  const toolsEmptyText =
    !isObjectInspectorMode
      ? "还没有工具调用。让 Hermes 检索资料库、展开草稿或整理知识卡片时，这里会显示状态流转。"
      : objectEventsLoading
        ? "正在读取当前对象的工具记录..."
        : `当前${mode === "answer_draft_review" ? "资料笔记" : "材料"}还没有可追踪的工具调用记录。`;

  useEffect(() => {
    if (!inspectorObjectRef) {
      setObjectEvents([]);
      setObjectEventsError("");
      setObjectEventsLoading(false);
      return;
    }
    let cancelled = false;
    setObjectEvents([]);
    setObjectEventsLoading(true);
    setObjectEventsError("");
    api.getKnowledgeObjectEvents(inspectorObjectRef.type, inspectorObjectRef.id, 30)
      .then((payload) => {
        if (cancelled) return;
        setObjectEvents(payload.events);
      })
      .catch((error) => {
        if (cancelled) return;
        setObjectEvents([]);
        setObjectEventsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setObjectEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectorObjectRef, objectEventsVersion]);

  const commitDraft = useCallback(async () => {
    if (!draftDetail) return;
    await commitDraftById(draftDetail.id, draftDetail.title);
  }, [commitDraftById, draftDetail]);

  const deleteDraft = useCallback(async () => {
    if (!draftDetail) return;
    await deleteDraftById(draftDetail.id, draftDetail.title);
  }, [deleteDraftById, draftDetail]);

  const reviseDraft = useCallback(async () => {
    if (!draftDetail || !revision.trim()) return;
    const operation = beginAiOperation("capture-revise");
    setDraftActionLoading("revise");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.reviseKnowledgeCaptureDraft(
        draftDetail.id,
        revision.trim(),
        { operationId: operation.operationId },
      );
      if (isAiCancelledResult(result)) {
        setDraftNotice("已停止。草稿内容未被覆盖。");
        return;
      }
      setDraftNotice("已提交修改，正在刷新草稿。");
      await loadDrafts();
      await loadDraftDetail(draftDetail.id);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionLoading(null);
      operation.finish();
    }
  }, [beginAiOperation, draftDetail, loadDraftDetail, loadDrafts, revision]);

  const editCommittedCaptureInLibrary = useCallback(() => {
    const captureId = draftDetail?.committed_capture_id?.trim() ?? "";
    if (!captureId) return;
    navigate(`/knowledge-library?kind=capture&item=${encodeURIComponent(captureId)}&mode=edit`);
  }, [draftDetail, navigate]);


  const openCardFlow = useCallback(async () => {
    if (!draftDetail) return;
    const captureId = draftDetail.committed_capture_id?.trim() ?? "";
    if (draftDetail.status !== "committed" || !captureId) {
      setDraftError("请先保存到资料库后再转换成知识卡片。");
      return;
    }
    const operation = beginAiOperation("capture-card");
    setDraftActionLoading("card");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.createKnowledgeGardenDraft(
        { capture_ids: [captureId] },
        { operationId: operation.operationId },
      );
      if (isAiCancelledResult(result)) {
        setDraftNotice("已停止。知识卡片未生成。");
        return;
      }
      if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
        throw new Error(gardenDraftError(result));
      }
      setDraftNotice(gardenDraftNotice(result));
      setObjectEventsVersion((current) => current + 1);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionLoading(null);
      operation.finish();
    }
  }, [beginAiOperation, draftDetail]);

  const composerPlaceholder =
    mode === "answer_draft_review"
      ? "检查这份回答沉淀草稿，满意后点确认保存；不满意可以回到对话继续追问..."
      : mode === "draft_review"
      ? "写修改意见，比如：把方法论部分展开、保留更多原文例子、删掉模板化表达..."
      : "直接问资料库，或让 Hermes 做跨篇灵感扫描与专题输出；也可以上传文件、粘贴材料...";

  const openGatewaySource = useCallback((source: {
    url?: string;
    open_url?: string;
    item_kind?: string;
    item_id?: string;
  }) => {
    if (source.url) {
      window.open(source.url, "_blank", "noopener,noreferrer");
      return;
    }
    const openUrl = source.open_url || (
      source.item_kind && source.item_id
        ? source.item_kind === "garden_card" || source.item_kind === "knowledge_card"
          ? `/cards-board/${encodeURIComponent(source.item_id)}`
          : `/knowledge-library?kind=${encodeURIComponent(source.item_kind)}&item=${encodeURIComponent(source.item_id)}`
        : ""
    );
    if (openUrl) {
      window.location.assign(openUrl);
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-foreground">
      <header className="flex min-h-[52px] shrink-0 items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-1.5">
        <div className="min-w-0">
          <h1 className="min-w-0 truncate text-base font-semibold tracking-normal text-foreground">
            专题洞察与输出专区 (Topics & Output Studio)
          </h1>
          <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
            跨篇灵感发现 · RAG 知识合成输出 · 文稿沉淀：把散落的卡片与资料，合成属于你的专题成果。
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs">
            <StatusPill
              icon={state.connection === "open" ? CheckCircle2 : Clock3}
              label={CONNECTION_LABEL[state.connection]}
              active={state.connection === "open"}
            />
            {state.running && (
              <StatusPill icon={Loader2} label={state.interruptRequested ? "正在停止" : "思考中"} active spin />
            )}
            {latestOpenDraft && (
              <button
                type="button"
                onClick={() => selectDraft(latestOpenDraft.id)}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/35 bg-primary/12 px-2.5 py-1 text-primary transition hover:bg-primary/18"
              >
                <FileText className="h-3.5 w-3.5" />
                审阅待审草稿 {openCount}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowInspector((value) => !value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition",
                showInspector
                  ? "border-primary/35 bg-primary/12 text-primary"
                  : "border-border bg-background/60 text-muted-foreground hover:text-foreground",
              )}
            >
              <FileText className="h-3.5 w-3.5" />
              {showInspector ? "隐藏详情" : "详情"}
            </button>
        </div>
      </header>

      {state.error && (
        <div className="flex shrink-0 items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{state.error}</span>
          <button
            type="button"
            onClick={reconnect}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-destructive/30 px-2 py-1 text-xs hover:bg-destructive/10"
          >
            <RefreshCw className="h-3 w-3" />
            重连
          </button>
        </div>
      )}

      {(draftError || draftNotice) && (
        <div
          className={cn(
            "flex shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-sm",
            draftError
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-primary/30 bg-primary/10 text-primary",
          )}
        >
          {draftError ? <AlertCircle className="mt-0.5 h-4 w-4" /> : <CheckCircle2 className="mt-0.5 h-4 w-4" />}
          <span>{draftError || draftNotice}</span>
        </div>
      )}

      <div
        ref={chatLayoutRef}
        style={chatLayoutStyle}
        className={cn(
          "grid min-h-0 flex-1 gap-0",
          showInspector
            ? "xl:grid-cols-[var(--knowledge-chat-sidebar-width)_8px_minmax(0,1fr)_8px_var(--knowledge-chat-inspector-width)]"
            : "xl:grid-cols-[var(--knowledge-chat-sidebar-width)_8px_minmax(0,1fr)]",
        )}
      >
        <WorkbenchSidebar
          connectionLabel={CONNECTION_LABEL[state.connection]}
          currentMode={mode}
          answerDrafts={filteredAnswerDrafts}
          answerDraftsLoading={answerDraftsLoading}
          drafts={filteredDrafts}
          filter={draftFilter}
          loading={draftsLoading}
          query={draftQuery}
          resumingSessionId={resumingSessionId}
          selectedAnswerDraftId={selectedAnswerDraftId}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          selectedDraftId={selectedDraftId}
          sessionId={state.sessionId}
          onFilterChange={setDraftFilter}
          onModeChange={setMode}
          onNewSession={() => void startNewSession()}
          onQueryChange={setDraftQuery}
          onRefresh={() => {
            void loadDrafts();
            void loadAnswerDrafts();
          }}
          onSelectAnswerDraft={(draftId) => void openAnswerDraft(draftId)}
          onResumeSession={(sessionId) => void resumeSession(sessionId)}
          onSelectDraft={selectDraft}
        />
        <ResizableRail
          containerRef={chatLayoutRef}
          defaultWidth={DEFAULT_CHAT_SIDEBAR_WIDTH}
          maxWidth={380}
          minWidth={240}
          onCommit={setSidebarWidth}
          storageKey={CHAT_SIDEBAR_WIDTH_KEY}
          variableName="--knowledge-chat-sidebar-width"
        />
        <main className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
          {mode === "answer_draft_review" ? (
            <ReadingDraftReview
              actionLoading={answerDraftActionLoading}
              detail={answerDraftDetail}
              loading={answerDraftLoading}
              revision={answerRevision}
              onCommit={() => void commitAnswerDraft()}
              onCreateCard={() => void convertAnswerDraftToCard()}
              onDelete={() => void deleteAnswerDraftById(answerDraftDetail?.id ?? "", answerDraftDetail?.title)}
              onRevise={() => void reviseAnswerDraft()}
              onRevisionChange={setAnswerRevision}
              onStopAiOperation={stopAiOperation}
              stoppingAiOperation={Boolean(aiOperation?.stopping)}
            />
          ) : mode === "draft_review" ? (
            <DraftReview
              actionLoading={draftActionLoading}
              detail={draftDetail}
              detailLoading={draftDetailLoading}
              revision={revision}
              view={draftView}
              onCommit={() => void commitDraft()}
              onDelete={() => void deleteDraft()}
              onEditCommittedCapture={editCommittedCaptureInLibrary}
              onOpenCardFlow={openCardFlow}
              onRevise={() => void reviseDraft()}
              onRevisionChange={setRevision}
              onStopAiOperation={stopAiOperation}
              stoppingAiOperation={Boolean(aiOperation?.stopping)}
              onViewChange={setDraftView}
            />
          ) : mode === "editable_capture" ? (
            <EditableCaptureWorkbench
              content={editableContent}
              draft={editableDraft}
              error={editableError}
              cardReason={editableCardReason}
              cardSuggestionsText={editableCardSuggestionsText}
              folderSuggestionMode={editableFolderSuggestionMode}
              folderSuggestionReason={editableFolderSuggestionReason}
              folderOptions={visibleFolderPaths.map((path) => ({ path, name: path }))}
              folderPath={editableFolder}
              cardCommitStatus={editableCardCommitStatus}
              generateCard={editableGenerateCard}
              progressMessage={editableProgressMessage}
              source={editableSource}
              status={editableStatus}
              summary={editableSummary}
              tagsText={editableTagsText}
              title={editableTitle}
              onCardReasonChange={setEditableCardReason}
              onCardSuggestionsTextChange={setEditableCardSuggestionsText}
              onCommit={() => void commitEditableCaptureDraft()}
              onContentChange={(value) => {
                setEditableContent(value);
                if (editableStatus !== "committed") {
                  setEditableStatus(value.trim() ? "editing" : "empty");
                  setEditableCardCommitStatus("idle");
                }
              }}
              onFolderChange={setEditableFolder}
              onFolderSuggestionModeChange={setEditableFolderSuggestionMode}
              onFolderSuggestionReasonChange={setEditableFolderSuggestionReason}
              onGenerateCardChange={setEditableGenerateCard}
              onOrganizeDraft={() => void organizeEditableCaptureDraft()}
              onStopAiOperation={stopAiOperation}
              stoppingAiOperation={Boolean(aiOperation?.stopping)}
              onSourceChange={setEditableSource}
              onSummaryChange={setEditableSummary}
              onTagsTextChange={setEditableTagsText}
              onTitleChange={(value) => {
                setEditableTitle(value);
                setEditableTitleSource("user");
                if (editableStatus !== "committed") setEditableStatus("editing");
              }}
            />
          ) : (
            <GatewayChat
              attachments={attachments}
              canSend={canSend}
              composerPlaceholder={composerPlaceholder}
              connection={state.connection}
              draftAssistant={state.draftAssistant}
              fileInputRef={fileInputRef}
              input={input}
              messages={state.messages}
              researchMode={researchMode}
              interruptRequested={state.interruptRequested}
              running={state.running}
              transcriptRef={transcriptRef}
              uploading={uploading}
              onInputChange={setInput}
              onPickPrompt={setInput}
              onResearchModeChange={setResearchMode}
              onRemoveAttachment={(id) =>
                setAttachments((current) => current.filter((item) => item.id !== id))
              }
              onSourceOpen={openGatewaySource}
              onSaveAnswer={createAnswerDraft}
              onStop={stopGeneration}
              onSubmit={submit}
              onUploadFiles={(files) => void uploadFiles(files)}
            />
          )}
        </main>

        {showInspector && (
          <>
            <ResizableRail
              containerRef={chatLayoutRef}
              defaultWidth={DEFAULT_CHAT_INSPECTOR_WIDTH}
              edge="left"
              maxWidth={520}
              minWidth={280}
              onCommit={setInspectorWidth}
              storageKey={CHAT_INSPECTOR_WIDTH_KEY}
              variableName="--knowledge-chat-inspector-width"
            />
            <KnowledgeInspector
              answerDetail={answerDraftDetail}
              connection={CONNECTION_LABEL[state.connection]}
              currentToolName={state.currentToolName}
              detail={mode === "editable_capture" ? editableDraft : draftDetail}
              inspectorObjectRef={inspectorObjectRef}
              mode={mode}
              objectEventsError={objectEventsError}
              objectEventsLoading={objectEventsLoading}
              onTabChange={setInspectorTab}
              openCount={openCount}
              running={state.running}
              selection={selection}
              sourceEmptyText={sourceEmptyText}
              sourceHints={inspectorSourceHints}
              tab={inspectorTab}
              tools={inspectorTools}
              toolsEmptyText={toolsEmptyText}
              turnIndex={state.turnIndex}
            />
          </>
        )}
      </div>
    </div>
  );
}

function buildVisibleUserText(text: string, attachments: ComposerAttachment[]): string {
  if (!attachments.length) return text;
  const fileList = attachments
    .map((attachment) => `- ${attachment.name}`)
    .join("\n");
  return `${text || "请处理我上传的附件。"}\n\n附件：\n${fileList}`;
}

function buildPromptText(text: string, attachments: ComposerAttachment[]): string {
  const fileRefs = attachments
    .filter((attachment) => attachment.kind === "file")
    .map((attachment) => `@file:"${attachment.path.replaceAll('"', '\\"')}"`);
  return [text, ...fileRefs].filter(Boolean).join("\n\n");
}

function withResearchModeInstruction(text: string, mode: KnowledgeChatResearchMode): string {
  const label: Record<KnowledgeChatResearchMode, string> = {
    local_only: "仅知识库",
    local_web: "知识库 + 联网搜索",
    theme_scan: "跨篇灵感扫描",
  };
  const citationInstruction =
    mode === "local_web"
      ? "使用联网搜索结果回答时，请尽量在关键结论后标注对应来源编号，如 [W1]。"
      : "";
  const toolInstruction =
    mode === "local_web"
      ? "请调用 research_with_web 统一完成知识库与联网检索，并传入 force_web=true；不要调用未提供的独立知识库搜索工具。"
      : mode === "theme_scan"
        ? "请调用 theme_scan 扫描知识卡片之间的跨篇关联；已有候选组用 theme_candidates 查看，需要关系画布时调用 generate_canvas。不要用 search_my_notes 临时拼组。"
        : "请只使用当前可用的知识库检索工具，不要调用联网搜索工具。";
  return [
    `【Hermes Knowledge 检索模式：${label[mode]}（mode=${mode}）】`,
    toolInstruction,
    citationInstruction,
    text,
  ].filter(Boolean).join("\n");
}

function isImageFile(name: string, mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return true;
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",", 2)[1] : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function isCommitDraftCommand(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "");
  if (!normalized) return false;
  return /^\/?(commit|save)-(capture|reading)-draft$/i.test(normalized)
    || /^\/?(commit|save)_?(capture|reading)_?draft$/i.test(normalized);
}

function bridgeMetaString(result: Record<string, unknown>, key: string): string {
  const meta = result.meta;
  if (!meta || typeof meta !== "object") return "";
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseTagsText(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function editableFolderSuggestion(intent: Record<string, unknown> | undefined): {
  mode: "existing" | "new";
  folder_path: string;
  reason: string;
} {
  const raw = intent?.folder_suggestion;
  const suggestion = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = suggestion.mode === "new" ? "new" : "existing";
  return {
    mode,
    folder_path: stringValue(suggestion.folder_path) || stringValue(intent?.folder_path) || "Inbox",
    reason: stringValue(suggestion.reason) || "AI 未返回明确文件夹建议，先放入 Inbox 等待人工确认。",
  };
}

function editableCardSuggestion(intent: Record<string, unknown> | undefined): {
  should_generate: boolean;
  reason: string;
  cards: Array<{ title: string; card_kind: string; reason: string }>;
} {
  const raw = intent?.card_suggestion;
  const suggestion = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const reason = stringValue(suggestion.reason);
  return {
    should_generate: suggestion.should_generate === true && Boolean(reason),
    reason: reason || "AI 未返回有效卡片建议，默认暂不生成 Garden Card。",
    cards: normalizeCardSuggestions(suggestion.cards),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCardSuggestions(value: unknown): Array<{ title: string; card_kind: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const card = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        title: stringValue(card.title),
        card_kind: normalizeGardenCardKind(stringValue(card.card_kind)),
        reason: stringValue(card.reason),
      };
    })
    .filter((card) => card.title || card.reason)
    .slice(0, 8);
}

function formatEditableCardSuggestions(value: unknown): string {
  return normalizeCardSuggestions(value)
    .map((card) => [card.title, card.card_kind, card.reason].filter(Boolean).join(" | "))
    .join("\n");
}

function editableAiSuggestionsStatus(draft: KnowledgeCaptureDraft): "generated" | "failed" | "not_generated" {
  const value = String(draft.capture_intent?.ai_suggestions_status || "");
  if (value === "generated" || value === "failed") return value;
  return "not_generated";
}

function editableDraftTitleSource(draft: KnowledgeCaptureDraft): "ai" | "user" {
  const source = draft.capture_intent?.title_source === "user" ? "user" : "ai";
  if (
    source === "user" &&
    editableAiSuggestionsStatus(draft) !== "generated" &&
    isGenericEditableTitle(draft.title || "")
  ) {
    return "ai";
  }
  return source;
}

function isGenericEditableTitle(title: string): boolean {
  return /^(?:整理稿|文字稿|未命名|无标题)(?:[ _-]?(?:副本|copy)|[（(]\d+[）)]|[ _-]?\d+)?$/i.test(title.trim());
}

function parseCardSuggestionsText(text: string): Array<{ title: string; card_kind: string; reason: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      return {
        title: parts[0] || "",
        card_kind: normalizeGardenCardKind(parts[1] || ""),
        reason: parts.slice(2).join(" | ") || parts[1] || "",
      };
    })
    .filter((card) => card.title || card.reason)
    .slice(0, 8);
}

function normalizeGardenCardKind(value: string): string {
  const kind = value.trim().toLowerCase();
  if (["viewpoint", "method", "fact", "risk"].includes(kind)) return kind;
  if (kind.includes("方法")) return "method";
  if (kind.includes("事实")) return "fact";
  if (kind.includes("风险")) return "risk";
  return kind ? "viewpoint" : "";
}

function firstGardenCardHint(text: string): { title?: string; card_kind?: string } {
  const [first] = parseCardSuggestionsText(text);
  return {
    title: first?.title || undefined,
    card_kind: first?.card_kind || undefined,
  };
}

function buildGardenDraftInstruction(reason: string, suggestionsText: string): string {
  const parts = [];
  if (reason.trim()) parts.push(`生成理由：${reason.trim()}`);
  if (suggestionsText.trim()) parts.push(`建议生成哪些卡：\n${suggestionsText.trim()}`);
  return parts.join("\n\n");
}

function knowledgeToolsetsForMode(mode: KnowledgeResearchMode): string[] {
  // Historical answers may carry `web_only`; it uses the same web research
  // toolset as local_web. Current article scope maps to the local toolset.
  if (mode === "local_web" || mode === "web_only") {
    return KNOWLEDGE_TOOLSETS_BY_MODE.local_web;
  }
  if (mode === "theme_scan") {
    return KNOWLEDGE_TOOLSETS_BY_MODE.theme_scan;
  }
  return KNOWLEDGE_TOOLSETS_BY_MODE.local_only ?? KNOWLEDGE_TOOLSETS;
}

function gatewayMessagesToWorkbench(messages: GatewayResumeMessage[]): {
  messages: KnowledgeMessage[];
  tools: ToolEntry[];
  toolSummaries: string[];
} {
  const now = Date.now();
  const visibleMessages: KnowledgeMessage[] = [];
  const tools: ToolEntry[] = [];
  let pendingToolSummaries: string[] = [];

  messages.forEach((message, index) => {
    const text = message.text || message.content || "";
    if (message.role === "tool") {
      const summary = text.trim();
      if (summary) pendingToolSummaries.push(summary);
      const structuredSummary = gatewayToolSourceSummary(message);
      if (structuredSummary) pendingToolSummaries.push(structuredSummary);
      tools.push({
        kind: "tool",
        id: `history-tool-${index}-${now}`,
        tool_id: `history-${index}`,
        name: message.name || message.tool_name || "tool",
        context: message.context,
        summary: summary || undefined,
        progressEvents: toolProgressEventsFromSummary(summary, now - (messages.length - index) * 1000),
        status: "done",
        startedAt: 0,
      });
      return;
    }
    if (message.role !== "user" && message.role !== "assistant") return;
    if (!text.trim()) return;
    const fullAnswer = message.role === "assistant"
      ? extractFullAnswerText(text, pendingToolSummaries)
      : "";
    const sourceHints = message.role === "assistant"
      ? extractSourceHints(fullAnswer || text, pendingToolSummaries)
      : undefined;
    const searchBackend = message.role === "assistant"
      ? searchBackendFromTrace(message.research_trace) ?? searchBackendFromToolSummaries(pendingToolSummaries)
      : undefined;
    visibleMessages.push({
      id: `history-${index}-${now}`,
      role: (message.role === "assistant" ? "assistant" : "user") as KnowledgeMessage["role"],
      text: fullAnswer || text,
      createdAt: now - (messages.length - index) * 1000,
      status: "complete" as const,
      sourceHints,
      searchBackend,
    });
    if (message.role === "assistant") {
      pendingToolSummaries = [];
    }
  });

  return {
    messages: visibleMessages,
    tools,
    toolSummaries: tools
      .map((tool) => tool.summary)
      .filter((summary): summary is string => Boolean(summary)),
  };
}

function gatewayToolSourceSummary(message: GatewayResumeMessage): string {
  const meta: Record<string, unknown> = {};
  if (Array.isArray(message.knowledge_sources)) meta.knowledge_sources = message.knowledge_sources;
  if (Array.isArray(message.web_sources)) meta.web_sources = message.web_sources;
  if (Array.isArray(message.retrieved_web_sources)) meta.retrieved_web_sources = message.retrieved_web_sources;
  if (message.research_trace && typeof message.research_trace === "object") meta.research_trace = message.research_trace;
  if (typeof message.answer_text === "string" && message.answer_text.trim()) meta.answer = message.answer_text.trim();
  const payload: Record<string, unknown> = {};
  if (Array.isArray(message.source_map)) payload.source_map = message.source_map;
  if (Object.keys(meta).length) payload.meta = meta;
  return Object.keys(payload).length ? JSON.stringify(payload) : "";
}

function shouldHydrateFromHistory(
  current: typeof initialKnowledgeChatState,
  historyMessages: KnowledgeMessage[],
): boolean {
  if (!historyMessages.length) return false;
  const currentAssistantCount = current.messages.filter((message) => message.role === "assistant").length;
  const historyAssistantCount = historyMessages.filter((message) => message.role === "assistant").length;
  if (historyAssistantCount > currentAssistantCount) return true;
  if (!current.running && !current.draftAssistant) return false;

  const currentUserCount = current.messages.filter((message) => message.role === "user").length;
  const historyUserCount = historyMessages.filter((message) => message.role === "user").length;
  const lastHistory = historyMessages[historyMessages.length - 1];
  if (lastHistory?.role !== "assistant" || !lastHistory.text.trim()) return false;
  if (historyUserCount < currentUserCount) return false;

  const draftText = current.draftAssistant?.text ?? "";
  return lastHistory.text.length >= draftText.length;
}

function StatusPill({
  active,
  icon: Icon,
  label,
  spin,
}: {
  active?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  spin?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
        active
          ? "border-primary/35 bg-primary/12 text-primary"
          : "border-current/10 bg-background/50 text-muted-foreground",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", spin && "animate-spin")} />
      {label}
    </span>
  );
}
