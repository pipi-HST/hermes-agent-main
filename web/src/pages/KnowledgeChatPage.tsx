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
  type KnowledgeCaptureDraft,
  type KnowledgeGardenDraftResponse,
  type KnowledgeObjectEvent,
  type KnowledgeReadingDraft,
  type KnowledgeResearchMode,
  type SessionInfo,
} from "@/lib/api";
import { GatewayClient, type ConnectionState } from "@/lib/gatewayClient";
import {
  extractSourceHints,
  initialKnowledgeChatState,
  knowledgeChatReducer,
  type KnowledgeMessage,
} from "@/lib/knowledgeChatState";
import { cn } from "@/lib/utils";
import { useLocation, useSearchParams } from "react-router-dom";
import { WorkbenchSidebar } from "@/pages/knowledge-chat/WorkbenchSidebar";
import { ReadingDraftReview } from "@/pages/knowledge-chat/ReadingDraftReview";
import { DraftReview } from "@/pages/knowledge-chat/DraftReview";
import {
  EditableCaptureWorkbench,
  type EditableCaptureStatus,
} from "@/pages/knowledge-chat/EditableCaptureWorkbench";
import { KnowledgeInspector } from "@/pages/knowledge-chat/Inspector";
import { GatewayChat } from "@/pages/knowledge-chat/GatewayChat";
import {
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
}

interface GatewayResumeResponse {
  session_id: string;
  resumed?: string;
  messages?: GatewayResumeMessage[];
}

interface GatewayAppendLocalMessagesResponse {
  appended: number;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"]);
const WORKBENCH_CACHE_KEY = "hermes-knowledge-workbench-cache-v1";
const WORKBENCH_LAST_SESSION_KEY = "hermes-knowledge-workbench-last-session-v1";
const KNOWLEDGE_TOOLSETS = ["knowledge-research"];
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const isCaptureReviewRoute = (pathname.replace(/\/$/, "") || "/") === "/capture-review";
  const [version, setVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gw = useMemo(() => new GatewayClient(), [version]);
  const [state, dispatch] = useReducer(
    knowledgeChatReducer,
    initialKnowledgeChatState,
  );
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const messageCounter = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hydratedPromptRef = useRef(false);
  const initialResumeTargetRef = useRef(searchParams.get("session"));
  const openedReadingDraftIdsRef = useRef(new Set<string>());
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
  const [draftActionLoading, setDraftActionLoading] = useState<"commit" | "revise" | "card" | "delete" | "update" | null>(null);
  const [draftError, setDraftError] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
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
  const [editableDraft, setEditableDraft] = useState<KnowledgeCaptureDraft | null>(null);
  const [editableStatus, setEditableStatus] = useState<EditableCaptureStatus>("empty");
  const [editableError, setEditableError] = useState("");
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
  const [researchMode, setResearchMode] = useState<KnowledgeResearchMode>("local_web");

  const nextId = useCallback((prefix: string) => {
    messageCounter.current += 1;
    return `${prefix}-${Date.now()}-${messageCounter.current}`;
  }, []);

  const loadDrafts = useCallback(async (options?: { selectLatestOpen?: boolean }) => {
    setDraftsLoading(true);
    setDraftError("");
    try {
      const payload = await api.getKnowledgeCaptureDrafts(100);
      setDrafts(payload.drafts);
      setSelectedDraftId((current) => {
        if (!options?.selectLatestOpen && current && payload.drafts.some((draft) => draft.id === current)) {
          return current;
        }
        return payload.drafts.find((draft) => OPEN_STATUSES.has(draft.status))?.id
          ?? payload.drafts[0]?.id
          ?? "";
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftsLoading(false);
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

  useEffect(() => {
    void loadDrafts();
    void loadAnswerDrafts();
    void loadSessions();
  }, [loadAnswerDrafts, loadDrafts, loadSessions]);

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
    const lastAssistant = [...state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const draftId = extractReadingDraftId(lastAssistant?.text ?? "");
    if (!draftId || openedReadingDraftIdsRef.current.has(draftId)) return;
    openedReadingDraftIdsRef.current.add(draftId);
    void openAnswerDraft(draftId);
  }, [openAnswerDraft, state.messages]);

  useEffect(() => {
    void loadDraftDetail(selectedDraftId);
  }, [loadDraftDetail, selectedDraftId]);

  useEffect(() => {
    const refreshWorkbench = () => {
      if (document.visibilityState === "hidden") return;
      void loadDrafts();
      void loadAnswerDrafts();
      void loadSessions();
      if (selectedDraftId) void loadDraftDetail(selectedDraftId);
    };
    window.addEventListener("focus", refreshWorkbench);
    document.addEventListener("visibilitychange", refreshWorkbench);
    return () => {
      window.removeEventListener("focus", refreshWorkbench);
      document.removeEventListener("visibilitychange", refreshWorkbench);
    };
  }, [loadAnswerDrafts, loadDraftDetail, loadDrafts, loadSessions, selectedDraftId]);

  useEffect(() => {
    const offState = gw.onState((connection) => {
      dispatch({ type: "connection", connection });
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
      void loadSessions();
      const readingDraftId = extractReadingDraftId(text);
      if (readingDraftId && !openedReadingDraftIdsRef.current.has(readingDraftId)) {
        openedReadingDraftIdsRef.current.add(readingDraftId);
        void openAnswerDraft(readingDraftId);
      }
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
      });
      if (/capture|draft/i.test(toolName)) {
        void loadDrafts();
        void loadAnswerDrafts();
      }
    });

    const offError = gw.on<ErrorPayload>("error", (ev) => {
      dispatch({
        type: "error",
        message: ev.payload?.message ?? "Hermes returned an unknown error.",
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
              enabled_toolsets: KNOWLEDGE_TOOLSETS,
            });
          } catch {
            window.localStorage.removeItem(WORKBENCH_LAST_SESSION_KEY);
          }
        }
        return gw.request<{ session_id: string }>("session.create", {
          enabled_toolsets: KNOWLEDGE_TOOLSETS,
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
      gw.close();
    };
  }, [gw, loadAnswerDrafts, loadDrafts, loadSessions, nextId, openAnswerDraft]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [state.messages, state.draftAssistant?.text]);

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
    setDraftActionLoading("commit");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.commitKnowledgeCaptureDraft(draftId);
      setDraftNotice(title ? `已入库到知识库：《${title}》。` : "已入库到知识库，草稿状态已刷新。");
      await loadDrafts();
      await loadDraftDetail(draftId);
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setDraftActionLoading(null);
    }
  }, [loadDraftDetail, loadDrafts]);

  const deleteDraftById = useCallback(async (draftId: string, title?: string): Promise<boolean> => {
    if (!draftId) return false;
    setDraftActionLoading("delete");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.deleteKnowledgeCaptureDraft(draftId);
      setDraftNotice(title ? `已删除草稿：《${title}》。` : "已删除草稿。");
      const payload = await api.getKnowledgeCaptureDrafts(100);
      setDrafts(payload.drafts);
      const nextDraftId = payload.drafts.find(
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
    const latestAssistant = [...state.messages]
      .reverse()
      .find((item) => item.role === "assistant");
    const sourceHints = latestAssistant?.id === message.id ? state.sourceHints : [];

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
        })),
        answer_source: sourceHints.length ? "latest_rag_full_answer" : "provided",
      });
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
    }
  }, [loadAnswerDrafts, state.messages, state.sessionId, state.sourceHints]);

  const commitAnswerDraft = useCallback(async () => {
    if (!answerDraftDetail) return;
    setAnswerDraftActionLoading("commit");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.commitKnowledgeReadingDraft(answerDraftDetail.id);
      setDraftNotice(`已保存：《${answerDraftDetail.title || "回答沉淀草稿"}》。`);
      const payload = await api.getKnowledgeReadingDraft(answerDraftDetail.id);
      setAnswerDraftDetail(payload.draft);
      await loadAnswerDrafts();
      await loadDrafts();
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftActionLoading(null);
    }
  }, [answerDraftDetail, loadAnswerDrafts, loadDrafts]);

  const reviseAnswerDraft = useCallback(async () => {
    if (!answerDraftDetail || !answerRevision.trim()) return;
    setAnswerDraftActionLoading("revise");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.reviseKnowledgeReadingDraft(answerDraftDetail.id, answerRevision.trim());
      setDraftNotice("已修改文稿草稿，正在刷新。");
      const payload = await api.getKnowledgeReadingDraft(answerDraftDetail.id);
      setAnswerDraftDetail(payload.draft);
      setAnswerRevision("");
      await loadAnswerDrafts();
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftActionLoading(null);
    }
  }, [answerDraftDetail, answerRevision, loadAnswerDrafts]);

  const convertAnswerDraftToCard = useCallback(async () => {
    if (!answerDraftDetail) return;
    const captureId = readingDraftCaptureId(answerDraftDetail);
    if (answerDraftDetail.output_type !== "local_learning_note" || answerDraftDetail.status !== "committed" || !captureId) {
      setDraftError("只有已入库的学习笔记可以转换成知识卡片。");
      return;
    }
    setAnswerDraftActionLoading("card");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.createKnowledgeGardenDraft({ capture_ids: [captureId] });
      if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
        throw new Error(gardenDraftError(result));
      }
      setDraftNotice(gardenDraftNotice(result));
      setObjectEventsVersion((current) => current + 1);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnswerDraftActionLoading(null);
    }
  }, [answerDraftDetail]);

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

    const openDrafts = drafts.filter((draft) => OPEN_STATUSES.has(draft.status));
    const selectedOpenDraft = openDrafts.find((draft) => draft.id === selectedDraftId);
    const target = selectedOpenDraft ?? (openDrafts.length === 1 ? openDrafts[0] : null);

    if (!target) {
      setDraftError(
        openDrafts.length > 1
          ? "现在有多个待审草稿，请先在左侧选择要入库的草稿，或进入草稿审阅页点击“入库到知识库”。"
          : "当前没有待审草稿可以入库。",
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
      ? `已入库到知识库：《${target.title || "未命名草稿"}》。`
      : `入库失败：《${target.title || "未命名草稿"}》。请查看上方错误提示。`;
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
    setInput("");
    setAttachments([]);

    gw.request("prompt.submit", { session_id: state.sessionId, text: finalText }).catch(
      (error: Error) => {
        dispatch({ type: "error", message: error.message });
      },
    );
  }, [attachments, canSend, gw, handleDraftCommand, input, nextId, researchMode, state.sessionId]);

  const reconnect = useCallback(() => {
    dispatch({ type: "reset_error" });
    setVersion((value) => value + 1);
  }, []);

  const startNewSession = useCallback(async () => {
    if (state.connection !== "open") return;
    setResumingSessionId("new");
    try {
      const created = await gw.request<{ session_id: string }>("session.create", {
        enabled_toolsets: KNOWLEDGE_TOOLSETS,
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
  }, [gw, setSearchParams, state.connection]);

  const resumeSession = useCallback(async (sessionId: string) => {
    if (state.connection !== "open") return;
    setResumingSessionId(sessionId);
    try {
      const result = await gw.request<GatewayResumeResponse>("session.resume", {
        session_id: sessionId,
        enabled_toolsets: KNOWLEDGE_TOOLSETS,
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
  }, [gw, setSearchParams, state.connection]);

  const saveEditableCaptureDraft = useCallback(async (): Promise<KnowledgeCaptureDraft | null> => {
    const content = editableContent.trim();
    if (!content) return null;
    setEditableStatus("saving_draft");
    setEditableError("");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = editableDraft?.id
        ? await api.updateKnowledgeEditableCaptureDraft(editableDraft.id, {
            content,
            title: editableTitle,
          })
        : await api.createKnowledgeEditableCaptureDraft({
            content,
            source: editableSource,
            source_type: "manual",
            title: editableTitle,
          });
      const draftId = bridgeMetaString(result, "draft_id") || editableDraft?.id || "";
      if (!draftId) throw new Error("没有返回草稿编号。");
      const payload = await api.getKnowledgeCaptureDraft(draftId);
      setEditableDraft(payload.draft);
      setEditableContent(payload.draft.draft_text || content);
      setEditableTitle(payload.draft.title || "");
      setSelectedDraftId(draftId);
      setSelection({ type: "draft", draftId });
      setEditableStatus("ready_to_commit");
      setDraftNotice("已整理成草稿，可以入库到知识库。");
      await loadDrafts();
      return payload.draft;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEditableError(message);
      setEditableStatus("error");
      return null;
    }
  }, [editableContent, editableDraft, editableSource, editableTitle, loadDrafts]);

  const commitEditableCaptureDraft = useCallback(async () => {
    const draft = await saveEditableCaptureDraft();
    if (!draft) return;
    setEditableStatus("committing");
    setEditableError("");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.commitKnowledgeCaptureDraft(draft.id);
      const payload = await api.getKnowledgeCaptureDraft(draft.id);
      setEditableDraft(payload.draft);
      setEditableContent(payload.draft.draft_text || "");
      setDraftDetail(payload.draft);
      setSelectedDraftId(draft.id);
      setSelection({ type: "draft", draftId: draft.id });
      setEditableStatus("committed");
      setDraftNotice(`已入库到知识库：《${payload.draft.title || "未命名草稿"}》。`);
      await loadDrafts();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEditableError(message);
      setEditableStatus("error");
    }
  }, [loadDrafts, saveEditableCaptureDraft]);

  const filteredDrafts = useMemo(() => {
    const text = draftQuery.trim().toLowerCase();
    return drafts.filter((draft) => {
      if (draftFilter === "open" && !OPEN_STATUSES.has(draft.status)) return false;
      if (draftFilter === "committed" && draft.status !== "committed") return false;
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

  const openCount = drafts.filter((draft) => OPEN_STATUSES.has(draft.status)).length;
  const latestOpenDraft = drafts.find((draft) => OPEN_STATUSES.has(draft.status));
  const inspectorObjectRef = useMemo<InspectorObjectRef>(() => {
    if (mode === "answer_draft_review" && answerDraftDetail?.id) {
      return {
        type: "reading_draft",
        id: answerDraftDetail.id,
        label: answerDraftDetail.title || "学习笔记",
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
        label: editableDraft.title || "粘贴整理草稿",
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
      ? "当前学习笔记没有可识别的引用来源。"
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
      ? "还没有工具调用。让 Hermes 检索知识库、展开草稿或整理 Garden 时，这里会显示状态流转。"
      : objectEventsLoading
        ? "正在读取当前对象的工具记录..."
        : `当前${mode === "answer_draft_review" ? "学习笔记" : "材料"}还没有可追踪的工具调用记录。`;

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
    setDraftActionLoading("revise");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.reviseKnowledgeCaptureDraft(draftDetail.id, revision.trim());
      setDraftNotice("已提交修改，正在刷新草稿。");
      await loadDrafts();
      await loadDraftDetail(draftDetail.id);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionLoading(null);
    }
  }, [draftDetail, loadDraftDetail, loadDrafts, revision]);

  const updateCommittedCapture = useCallback(async (body: string, title: string) => {
    if (!draftDetail?.committed_capture_id) return;
    setDraftActionLoading("update");
    setDraftError("");
    setDraftNotice("");
    try {
      await api.updateKnowledgeCapture(draftDetail.committed_capture_id, { body, title });
      setDraftNotice("已保存已入库笔记，并重新维护检索索引。");
      await loadDrafts();
      await loadDraftDetail(draftDetail.id);
      setObjectEventsVersion((current) => current + 1);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionLoading(null);
    }
  }, [draftDetail, loadDraftDetail, loadDrafts]);

  const openCardFlow = useCallback(async () => {
    if (!draftDetail) return;
    const captureId = draftDetail.committed_capture_id?.trim() ?? "";
    if (draftDetail.status !== "committed" || !captureId) {
      setDraftError("请先入库到知识库后再转换成知识卡片。");
      return;
    }
    setDraftActionLoading("card");
    setDraftError("");
    setDraftNotice("");
    try {
      const result = await api.createKnowledgeGardenDraft({ capture_ids: [captureId] });
      if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
        throw new Error(gardenDraftError(result));
      }
      setDraftNotice(gardenDraftNotice(result));
      setObjectEventsVersion((current) => current + 1);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionLoading(null);
    }
  }, [draftDetail]);

  const composerPlaceholder =
    mode === "answer_draft_review"
      ? "检查这份回答沉淀草稿，满意后点确认保存；不满意可以回到对话继续追问..."
      : mode === "draft_review"
      ? "写修改意见，比如：把方法论部分展开、保留更多原文例子、删掉模板化表达..."
      : "直接问知识库、上传文件、粘贴材料，或者让 Hermes 整理主题关联...";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-foreground">
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-3 rounded-lg border border-border bg-background px-4">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-normal text-foreground">
          满血对话
        </h1>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs">
            <StatusPill
              icon={state.connection === "open" ? CheckCircle2 : Clock3}
              label={CONNECTION_LABEL[state.connection]}
              active={state.connection === "open"}
            />
            {state.running && (
              <StatusPill icon={Loader2} label="思考中" active spin />
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
              onOpenCardFlow={openCardFlow}
              onRevise={() => void reviseDraft()}
              onRevisionChange={setRevision}
              onUpdateCommittedCapture={(body, title) => void updateCommittedCapture(body, title)}
              onViewChange={setDraftView}
            />
          ) : mode === "editable_capture" ? (
            <EditableCaptureWorkbench
              content={editableContent}
              draft={editableDraft}
              error={editableError}
              source={editableSource}
              status={editableStatus}
              title={editableTitle}
              onCommit={() => void commitEditableCaptureDraft()}
              onContentChange={(value) => {
                setEditableContent(value);
                if (editableStatus !== "committed") {
                  setEditableStatus(value.trim() ? "editing" : "empty");
                }
              }}
              onSaveDraft={() => void saveEditableCaptureDraft()}
              onSourceChange={setEditableSource}
              onTitleChange={(value) => {
                setEditableTitle(value);
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
              running={state.running}
              transcriptRef={transcriptRef}
              uploading={uploading}
              onInputChange={setInput}
              onPickPrompt={setInput}
              onResearchModeChange={setResearchMode}
              onRemoveAttachment={(id) =>
                setAttachments((current) => current.filter((item) => item.id !== id))
              }
              onSaveAnswer={createAnswerDraft}
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

function withResearchModeInstruction(text: string, mode: KnowledgeResearchMode): string {
  const label: Record<KnowledgeResearchMode, string> = {
    current_article_only: "当前文章",
    local_only: "仅知识库",
    local_web: "知识库 + 联网搜索",
    web_only: "联网搜索",
  };
  return [
    `【Hermes Knowledge 检索模式：${label[mode]}（mode=${mode}）】`,
    text,
  ].join("\n");
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

function extractReadingDraftId(text: string): string {
  const patterns = [
    /草稿编号[：:\s]+([a-zA-Z0-9_-]{8,})/,
    /reading_draft_id["'\s:：]+([a-zA-Z0-9_-]{8,})/,
    /draft_id["'\s:：]+([a-zA-Z0-9_-]{8,})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function bridgeMetaString(result: Record<string, unknown>, key: string): string {
  const meta = result.meta;
  if (!meta || typeof meta !== "object") return "";
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function gatewayMessagesToWorkbench(messages: GatewayResumeMessage[]): {
  messages: KnowledgeMessage[];
  tools: ToolEntry[];
  toolSummaries: string[];
} {
  const now = Date.now();
  const visibleMessages: KnowledgeMessage[] = [];
  const tools: ToolEntry[] = [];

  messages.forEach((message, index) => {
    const text = message.text || message.content || "";
    if (message.role === "tool") {
      const summary = text.trim();
      tools.push({
        kind: "tool",
        id: `history-tool-${index}-${now}`,
        tool_id: `history-${index}`,
        name: message.name || message.tool_name || "tool",
        context: message.context,
        summary: summary || undefined,
        status: "done",
        startedAt: 0,
      });
      return;
    }
    if (message.role !== "user" && message.role !== "assistant") return;
    if (!text.trim()) return;
    visibleMessages.push({
      id: `history-${index}-${now}`,
      role: (message.role === "assistant" ? "assistant" : "user") as KnowledgeMessage["role"],
      text,
      createdAt: now - (messages.length - index) * 1000,
      status: "complete" as const,
    });
  });

  return {
    messages: visibleMessages,
    tools,
    toolSummaries: tools
      .map((tool) => tool.summary)
      .filter((summary): summary is string => Boolean(summary)),
  };
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
