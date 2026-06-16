import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  ArrowUp,
  BookMarked,
  Braces,
  CheckCircle2,
  CircleDot,
  Clock3,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  MessageSquareText,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { ToolCall } from "@/components/ToolCall";
import {
  api,
  type KnowledgeCaptureDraft,
  type KnowledgeReadingDraft,
  type SessionInfo,
} from "@/lib/api";
import { GatewayClient, type ConnectionState } from "@/lib/gatewayClient";
import {
  initialKnowledgeChatState,
  knowledgeChatReducer,
  type KnowledgeMessage,
} from "@/lib/knowledgeChatState";
import { cn, timeAgo } from "@/lib/utils";
import { useSearchParams } from "react-router-dom";

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
}

interface ToolCompletePayload {
  tool_id?: string;
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
  name?: string;
  context?: string;
}

interface GatewayResumeResponse {
  session_id: string;
  resumed?: string;
  messages?: GatewayResumeMessage[];
}

interface GatewayAppendLocalMessagesResponse {
  appended: number;
}

interface ComposerAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

const PROMPT_STARTERS = [
  "基于知识库回答这个问题：",
  "展开最近的 Capture 草稿",
  "扫描最近保存的内容，看看有没有可整理的关联",
];

const OPEN_STATUSES = new Set([
  "open",
  "raw_extracted",
  "draft_ready",
  "revision_requested",
  "draft_incomplete",
]);

const DRAFT_FILTERS = [
  { key: "open", label: "待审" },
  { key: "all", label: "全部" },
  { key: "committed", label: "已入库" },
] as const;

type DraftFilterKey = (typeof DRAFT_FILTERS)[number]["key"];
type WorkbenchMode = "chat" | "draft_review" | "answer_draft_review" | "source" | "result";
type AnswerOutputType = "auto" | "local_learning_note" | "knowledge_card" | "enhance_capture";
type DraftView = "draft" | "raw" | "meta";
type InspectorTab = "sources" | "tools" | "status";

type WorkbenchSelection =
  | { type: "conversation"; sessionId: string }
  | { type: "draft"; draftId: string }
  | { type: "material"; captureId: string }
  | { type: "card"; cardId: string };

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"]);
const WORKBENCH_CACHE_KEY = "hermes-knowledge-workbench-cache-v1";
const WORKBENCH_LAST_SESSION_KEY = "hermes-knowledge-workbench-last-session-v1";
const KNOWLEDGE_TOOLSETS = ["personal-assistant"];

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "已连接",
  closed: "已断开",
  error: "连接错误",
};

export default function KnowledgeChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [mode, setMode] = useState<WorkbenchMode>("chat");
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
  const [draftActionLoading, setDraftActionLoading] = useState<"commit" | "revise" | "card" | null>(null);
  const [draftError, setDraftError] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  const [answerDrafts, setAnswerDrafts] = useState<KnowledgeReadingDraft[]>([]);
  const [answerDraftsLoading, setAnswerDraftsLoading] = useState(true);
  const [selectedAnswerDraftId, setSelectedAnswerDraftId] = useState("");
  const [answerDraftDetail, setAnswerDraftDetail] = useState<KnowledgeReadingDraft | null>(null);
  const [answerDraftLoading, setAnswerDraftLoading] = useState(false);
  const [answerDraftActionLoading, setAnswerDraftActionLoading] = useState<"create" | "commit" | "revise" | null>(null);
  const [answerRevision, setAnswerRevision] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("sources");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [resumingSessionId, setResumingSessionId] = useState("");

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
      const cached = JSON.parse(raw) as { messages?: KnowledgeMessage[] };
      if (Array.isArray(cached.messages) && cached.messages.length) {
        dispatch({ type: "hydrate_messages", messages: cached.messages });
      }
    } catch {
      window.localStorage.removeItem(WORKBENCH_CACHE_KEY);
    }
  }, []);

  useEffect(() => {
    const messages = state.messages.slice(-80);
    if (!messages.length) return;
    window.localStorage.setItem(
      WORKBENCH_CACHE_KEY,
      JSON.stringify({ messages, savedAt: Date.now() }),
    );
  }, [state.messages]);

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
      });
    });

    const offToolComplete = gw.on<ToolCompletePayload>("tool.complete", (ev) => {
      const toolId = ev.payload?.tool_id;
      if (!toolId) return;
      dispatch({
        type: "tool_complete",
        toolId,
        summary: ev.payload?.summary,
        error: ev.payload?.error,
        inlineDiff: ev.payload?.inline_diff,
      });
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
        const resumed = (created as GatewayResumeResponse).resumed;
        const messages = (created as GatewayResumeResponse).messages;
        if (resumed) {
          setSelection({ type: "conversation", sessionId: resumed });
          window.localStorage.setItem(WORKBENCH_LAST_SESSION_KEY, resumed);
        }
        if (Array.isArray(messages)) {
          dispatch({
            type: "hydrate_messages",
            messages: gatewayMessagesToWorkbench(messages),
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
  }, [gw, loadDrafts, loadSessions, nextId, openAnswerDraft]);

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
      setDraftNotice(title ? `已确认入库：《${title}》。` : "已确认入库，草稿状态已刷新。");
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
          type: source.origin,
          id: source.id,
          title: source.label,
          label: source.label,
          url: source.url,
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
          ? "现在有多个待审草稿，请先在左侧选择要入库的草稿，或进入草稿审阅页点击“确认入库”。"
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
      ? `已确认入库：《${target.title || "未命名草稿"}》。`
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
    const finalText = buildPromptText(text || "请处理我上传的附件。", selectedAttachments);

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
  }, [attachments, canSend, gw, handleDraftCommand, input, nextId, state.sessionId]);

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
      dispatch({
        type: "hydrate_messages",
        messages: gatewayMessagesToWorkbench(result.messages ?? []),
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
  const committedCount =
    drafts.filter((draft) => draft.status === "committed").length
    + answerDrafts.filter((draft) => draft.status === "committed").length;
  const openAnswerDraftCount = answerDrafts.filter((draft) => draft.status === "open").length;
  const latestOpenDraft = drafts.find((draft) => OPEN_STATUSES.has(draft.status));
  const recentCommitted = drafts.filter((draft) => draft.status === "committed").slice(0, 3);

  const commitDraft = useCallback(async () => {
    if (!draftDetail) return;
    await commitDraftById(draftDetail.id, draftDetail.title);
  }, [commitDraftById, draftDetail]);

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

  const openCardFlow = useCallback(() => {
    if (!draftDetail) return;
    setInput(`把 Capture 草稿《${draftDetail.title}》整理成一张 Knowledge Card 草稿。草稿编号：${draftDetail.id}`);
    setMode("chat");
  }, [draftDetail]);

  const composerPlaceholder =
    mode === "answer_draft_review"
      ? "检查这份回答沉淀草稿，满意后点确认保存；不满意可以回到对话继续追问..."
      : mode === "draft_review"
      ? "写修改意见，比如：把方法论部分展开、保留更多原文例子、删掉模板化表达..."
      : "直接问知识库、上传文件、粘贴材料，或者让 Hermes 整理主题关联...";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 normal-case text-foreground">
      <header className="shrink-0 overflow-hidden rounded-lg border border-current/10 bg-background-base/80 px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.22)] backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-primary/80">
              <Sparkles className="h-3.5 w-3.5" />
              Hermes Knowledge
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-normal text-foreground">
              满血对话工作台
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              复用同一个 Hermes 主 Agent 和知识库工具链，适合查看长答案、完整草稿、引用来源和工具调用过程。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusPill
              icon={state.connection === "open" ? CheckCircle2 : Clock3}
              label={CONNECTION_LABEL[state.connection]}
              active={state.connection === "open"}
            />
            <StatusPill
              icon={Braces}
              label={state.sessionId ? `Session ${state.sessionId}` : "等待会话"}
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
          </div>
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

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)_340px]">
        <WorkbenchRail
          committedCount={committedCount}
          connectionLabel={CONNECTION_LABEL[state.connection]}
          currentMode={mode}
          answerDrafts={filteredAnswerDrafts}
          answerDraftsLoading={answerDraftsLoading}
          drafts={filteredDrafts}
          filter={draftFilter}
          loading={draftsLoading}
          openAnswerDraftCount={openAnswerDraftCount}
          openCount={openCount}
          query={draftQuery}
          recentCommitted={recentCommitted}
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
        <main className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-current/10 bg-background-base/75 shadow-[0_18px_80px_rgba(0,0,0,0.20)] backdrop-blur">
          {mode === "answer_draft_review" ? (
            <AnswerDraftReviewWorkspace
              actionLoading={answerDraftActionLoading}
              detail={answerDraftDetail}
              loading={answerDraftLoading}
              revision={answerRevision}
              onCommit={() => void commitAnswerDraft()}
              onRevise={() => void reviseAnswerDraft()}
              onRevisionChange={setAnswerRevision}
            />
          ) : mode === "draft_review" ? (
            <DraftReviewWorkspace
              actionLoading={draftActionLoading}
              detail={draftDetail}
              detailLoading={draftDetailLoading}
              revision={revision}
              view={draftView}
              onCommit={() => void commitDraft()}
              onOpenCardFlow={openCardFlow}
              onRevise={() => void reviseDraft()}
              onRevisionChange={setRevision}
              onViewChange={setDraftView}
            />
          ) : (
            <>
              <div
                ref={transcriptRef}
                className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
              >
                {state.messages.length === 0 && !state.draftAssistant ? (
                  <EmptyState onPick={setInput} />
                ) : (
                  <div className="space-y-5">
                    {state.messages.map((message) => (
                      <TranscriptMessage
                        key={message.id}
                        message={message}
                        onSaveAnswer={createAnswerDraft}
                      />
                    ))}
                    {state.draftAssistant && (
                      <TranscriptMessage message={state.draftAssistant} streaming />
                    )}
                  </div>
                )}
              </div>

              <footer className="shrink-0 border-t border-current/10 bg-background-base/90 p-3">
                <div
                  className="rounded-lg border border-current/10 bg-background/45 p-2"
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void uploadFiles(event.dataTransfer.files);
                  }}
                >
                  {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {attachments.map((attachment) => (
                        <AttachmentChip
                          key={attachment.id}
                          attachment={attachment}
                          onRemove={() =>
                            setAttachments((current) =>
                              current.filter((item) => item.id !== attachment.id),
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        if (event.currentTarget.files) {
                          void uploadFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={state.running || uploading || state.connection !== "open"}
                      className={cn(
                        "flex h-16 w-12 shrink-0 items-center justify-center rounded-md border text-sm transition",
                        state.running || uploading || state.connection !== "open"
                          ? "border-current/10 bg-muted/40 text-muted-foreground"
                          : "border-current/15 bg-background/70 text-foreground hover:border-primary/45 hover:bg-primary/10",
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
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          submit();
                        }
                      }}
                      placeholder={composerPlaceholder}
                      className="min-h-16 flex-1 resize-none rounded-md border border-current/15 bg-background/70 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
                    />
                    <button
                      type="button"
                      onClick={submit}
                      disabled={!canSend}
                      className={cn(
                        "flex h-16 w-12 shrink-0 items-center justify-center rounded-md border text-sm transition",
                        canSend
                          ? "border-primary/50 bg-primary text-primary-foreground shadow-[0_12px_30px_rgba(0,0,0,0.22)] hover:brightness-110"
                          : "border-current/10 bg-muted/40 text-muted-foreground",
                      )}
                      aria-label="发送"
                    >
                      {state.running ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowUp className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              </footer>
            </>
          )}
        </main>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-current/10 bg-background-base/75 shadow-[0_18px_60px_rgba(0,0,0,0.18)] backdrop-blur">
          <div className="flex shrink-0 gap-1 border-b border-current/10 p-2">
            {[
              ["sources", "来源"],
              ["tools", "工具"],
              ["status", "状态"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setInspectorTab(key as InspectorTab)}
                className={cn(
                  "flex-1 rounded px-2 py-1.5 text-xs transition",
                  inspectorTab === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {inspectorTab === "sources" && (
              <InspectorPanel title="引用与来源" icon={BookMarked}>
            {state.sourceHints.length ? (
              <div className="space-y-2">
                {state.sourceHints.map((source) => (
                  <div
                    key={source.id}
                    className="rounded-md border border-current/10 bg-background/55 p-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {source.sourceType && (
                            <span className={`rounded px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide ${sourceTypeColor(source.sourceType)}`}>
                              {sourceTypeLabel(source.sourceType)}
                            </span>
                          )}
                          <p className="break-words text-sm leading-5 text-foreground">
                            {source.url ? (
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                                className="underline decoration-primary/30 underline-offset-2 hover:decoration-primary/70"
                              >
                                {source.label}
                              </a>
                            ) : (
                              source.label
                            )}
                          </p>
                        </div>
                        {source.filePath && (
                          <p className="mt-1 truncate font-mono text-[0.68rem] text-muted-foreground/70">
                            {source.filePath}
                          </p>
                        )}
                        {source.excerpt && (
                          <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
                            {source.excerpt}
                          </p>
                        )}
                        {!source.sourceType && !source.filePath && !source.excerpt && (
                          <p className="mt-1 text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">
                            {source.origin === "answer" ? "answer" : "tool"}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <PanelEmpty text="当前回答还没有可识别的来源。RAG 工具返回引用时会在这里集中展示。" />
            )}
              </InspectorPanel>
            )}

            {inspectorTab === "tools" && (
              <InspectorPanel title="工具调用" icon={FileText}>
            {state.tools.length ? (
              <div className="space-y-2">
                {(() => {
                  const reversed = state.tools.slice().reverse();
                  let lastTurn: number | undefined;
                  return reversed.map((tool) => {
                    const showSep =
                      tool.turnIndex != null &&
                      lastTurn != null &&
                      tool.turnIndex !== lastTurn;
                    lastTurn = tool.turnIndex;
                    return (
                      <div key={tool.id}>
                        {showSep && (
                          <div className="my-1.5 flex items-center gap-2 text-[0.6rem] uppercase tracking-widest text-muted-foreground/50">
                            <div className="h-px flex-1 bg-current/10" />
                            <span>Turn {tool.turnIndex}</span>
                            <div className="h-px flex-1 bg-current/10" />
                          </div>
                        )}
                        <ToolCall tool={tool} />
                      </div>
                    );
                  });
                })()}
              </div>
            ) : (
              <PanelEmpty text="还没有工具调用。让 Hermes 检索知识库、展开草稿或整理 Garden 时，这里会显示状态流转。" />
            )}
              </InspectorPanel>
            )}

            {inspectorTab === "status" && (
              <InspectorPanel title="当前状态" icon={CircleDot}>
                <StatusInspector
                  answerDetail={answerDraftDetail}
                  connection={CONNECTION_LABEL[state.connection]}
                  currentToolName={state.currentToolName}
                  detail={draftDetail}
                  mode={mode}
                  openCount={openCount}
                  running={state.running}
                  selection={selection}
                  toolsCount={state.tools.length}
                  turnIndex={state.turnIndex}
                />
              </InspectorPanel>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function WorkbenchRail({
  answerDrafts,
  answerDraftsLoading,
  committedCount,
  connectionLabel,
  currentMode,
  drafts,
  filter,
  loading,
  openAnswerDraftCount,
  openCount,
  query,
  recentCommitted,
  resumingSessionId,
  selectedAnswerDraftId,
  sessions,
  sessionsLoading,
  selectedDraftId,
  sessionId,
  onFilterChange,
  onModeChange,
  onNewSession,
  onQueryChange,
  onRefresh,
  onSelectAnswerDraft,
  onResumeSession,
  onSelectDraft,
}: {
  answerDrafts: KnowledgeReadingDraft[];
  answerDraftsLoading: boolean;
  committedCount: number;
  connectionLabel: string;
  currentMode: WorkbenchMode;
  drafts: KnowledgeCaptureDraft[];
  filter: DraftFilterKey;
  loading: boolean;
  openAnswerDraftCount: number;
  openCount: number;
  query: string;
  recentCommitted: KnowledgeCaptureDraft[];
  resumingSessionId: string;
  selectedAnswerDraftId: string;
  sessions: SessionInfo[];
  sessionsLoading: boolean;
  selectedDraftId: string;
  sessionId: string | null;
  onFilterChange: (filter: DraftFilterKey) => void;
  onModeChange: (mode: WorkbenchMode) => void;
  onNewSession: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelectAnswerDraft: (draftId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onSelectDraft: (draftId: string) => void;
}) {
  const listTitle = ({
    open: "待审草稿",
    all: "全部草稿",
    committed: "已入库材料",
  } as Record<DraftFilterKey, string>)[filter];

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-current/10 bg-background-base/75 shadow-[0_18px_70px_rgba(0,0,0,0.18)] backdrop-blur">
      <div className="shrink-0 border-b border-current/10 p-3">
        <button
          type="button"
          onClick={() => onModeChange("chat")}
          className={cn(
            "mb-3 w-full rounded-md border px-3 py-2 text-left transition",
            currentMode === "chat"
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-current/10 bg-background/45 text-muted-foreground hover:text-foreground",
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <MessageSquareText className="h-4 w-4" />
            当前对话
          </div>
          <p className="mt-1 truncate text-xs">{sessionId ? `Session ${sessionId}` : connectionLabel}</p>
        </button>

        <div className="mb-3">
          <button
            type="button"
            onClick={onNewSession}
            disabled={Boolean(resumingSessionId)}
            className="w-full rounded-md border border-current/10 bg-background/45 px-3 py-2 text-left text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-50"
          >
            新对话
          </button>
        </div>

        <div className="mb-3 rounded-md border border-current/10 bg-background/35 p-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              对话历史
            </h2>
            {sessionsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {sessions.length ? (
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {sessions.slice(0, 5).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onResumeSession(session.id)}
                  disabled={Boolean(resumingSessionId)}
                  className="w-full rounded border border-transparent px-2 py-1.5 text-left transition hover:border-current/10 hover:bg-background/60 disabled:opacity-50"
                >
                  <span className="line-clamp-1 text-xs text-foreground">
                    {session.title || session.preview || session.id}
                  </span>
                  <span className="mt-0.5 block text-[0.68rem] text-muted-foreground">
                    {resumingSessionId === session.id ? "恢复中..." : `${timeAgo(session.last_active || session.started_at)} · ${session.message_count} 条`}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">暂无可恢复的历史对话。</p>
          )}
        </div>

        <div className="mb-3 grid grid-cols-3 gap-2">
          <Metric label="材料" value={openCount} />
          <Metric label="文稿" value={openAnswerDraftCount} />
          <Metric label="已入库" value={committedCount} />
        </div>

        <div className="flex gap-1 rounded-md border border-current/10 bg-background/40 p-1">
          {DRAFT_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onFilterChange(item.key)}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-xs transition",
                filter === item.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="mt-3 flex items-center gap-2 rounded-md border border-current/10 bg-background/55 px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索草稿、来源或意图"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              回答/文稿草稿
            </h2>
            {answerDraftsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {answerDraftsLoading ? (
            <LoadingBlock text="读取文稿草稿..." />
          ) : answerDrafts.length ? (
            <div className="space-y-2">
              {answerDrafts.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => onSelectAnswerDraft(draft.id)}
                  className={cn(
                    "w-full rounded-md border p-3 text-left transition",
                    selectedAnswerDraftId === draft.id && currentMode === "answer_draft_review"
                      ? "border-primary/45 bg-primary/10"
                      : "border-current/10 bg-background/45 hover:border-primary/25 hover:bg-background/70",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">
                      {draft.title || "未命名文稿"}
                    </h3>
                    <StatusBadge status={draft.status} />
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {draft.summary || draft.draft_preview || "暂无预览"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <TinyPill>{answerDraftTypeLabel(draft.output_type)}</TinyPill>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <PanelEmpty text="还没有回答/文稿草稿。让 Hermes 整理对话或点击回答上的存为笔记后会出现在这里。" />
          )}
        </div>

        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            材料草稿 · {listTitle}
          </h2>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded p-1 text-muted-foreground hover:bg-background/70 hover:text-foreground"
            aria-label="刷新草稿"
            title="刷新草稿"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>

        {loading ? (
          <LoadingBlock text="读取草稿列表..." />
        ) : drafts.length ? (
          <div className="space-y-2">
            {drafts.map((draft) => (
              <button
                key={draft.id}
                type="button"
                onClick={() => onSelectDraft(draft.id)}
                className={cn(
                  "w-full rounded-md border p-3 text-left transition",
                  selectedDraftId === draft.id && currentMode === "draft_review"
                    ? "border-primary/45 bg-primary/10"
                    : "border-current/10 bg-background/45 hover:border-primary/25 hover:bg-background/70",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">
                    {draft.title || "未命名草稿"}
                  </h3>
                  <StatusBadge status={draft.status} />
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {draft.summary || draft.draft_preview || draft.raw_preview || "暂无预览"}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <TinyPill>{intentLabel(draft.user_intent)}</TinyPill>
                  {draft.source_type && <TinyPill>{draft.source_type}</TinyPill>}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <PanelEmpty text="没有符合条件的草稿。生成 Capture 草稿后会出现在这里。" />
        )}

        {filter !== "committed" && (
        <div className="mt-4 border-t border-current/10 pt-3">
          <h2 className="px-1 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            最近入库
          </h2>
          {recentCommitted.length ? (
            <div className="mt-2 space-y-2">
              {recentCommitted.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => onSelectDraft(draft.id)}
                  className="w-full rounded-md border border-current/10 bg-background/35 p-2 text-left text-xs leading-5 text-muted-foreground transition hover:border-primary/25 hover:text-foreground"
                >
                  <span className="line-clamp-2">{draft.title || "已入库材料"}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
              最近确认入库的材料会显示在这里。
            </p>
          )}
        </div>
        )}
      </div>
    </aside>
  );
}

function AnswerDraftReviewWorkspace({
  actionLoading,
  detail,
  loading,
  revision,
  onCommit,
  onRevise,
  onRevisionChange,
}: {
  actionLoading: "create" | "commit" | "revise" | null;
  detail: KnowledgeReadingDraft | null;
  loading: boolean;
  revision: string;
  onCommit: () => void;
  onRevise: () => void;
  onRevisionChange: (value: string) => void;
}) {
  if (loading) return <LoadingBlock text="读取回答沉淀草稿..." />;
  if (!detail) return <PanelEmpty text="请选择一条 Hermes 回答，生成可审阅的知识草稿。" />;

  const typeLabel = ({
    local_learning_note: "学习笔记草稿",
    knowledge_card: "知识卡片草稿",
    enhance_capture: "主笔记增强草稿",
  } as Record<string, string>)[detail.output_type] ?? "回答沉淀草稿";
  const canCommit = detail.status === "open";

  return (
    <>
      <div className="shrink-0 border-b border-current/10 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {typeLabel}
              </span>
              <StatusBadge status={detail.status} />
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
              {detail.title || "未命名草稿"}
            </h2>
          </div>
          <ActionButton
            onClick={onCommit}
            disabled={!canCommit || Boolean(actionLoading)}
            loading={actionLoading === "commit"}
          >
            确认保存
          </ActionButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {detail.draft_text || detail.draft_preview ? (
          <Markdown content={detail.draft_text || detail.draft_preview} />
        ) : (
          <PanelEmpty text="这份回答沉淀草稿还没有正文。" />
        )}
      </div>

      <div className="shrink-0 border-t border-current/10 bg-background-base/90 p-3">
        <div className="flex flex-col gap-2 lg:flex-row">
          <textarea
            value={revision}
            onChange={(event) => onRevisionChange(event.target.value)}
            placeholder="写修改意见，比如：删掉重复段落、把第二部分展开、改成更像正式文稿..."
            className="min-h-20 flex-1 resize-none rounded-md border border-current/15 bg-background/70 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="button"
            onClick={onRevise}
            disabled={!revision.trim() || detail.status !== "open" || Boolean(actionLoading)}
            className="inline-flex min-h-20 items-center justify-center gap-2 rounded-md border border-primary/45 bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[0_12px_30px_rgba(0,0,0,0.22)] transition hover:brightness-110 disabled:border-current/10 disabled:bg-muted/40 disabled:text-muted-foreground"
          >
            {actionLoading === "revise" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            继续修改
          </button>
        </div>
      </div>
    </>
  );
}

function DraftReviewWorkspace({
  actionLoading,
  detail,
  detailLoading,
  revision,
  view,
  onCommit,
  onOpenCardFlow,
  onRevise,
  onRevisionChange,
  onViewChange,
}: {
  actionLoading: "commit" | "revise" | "card" | null;
  detail: KnowledgeCaptureDraft | null;
  detailLoading: boolean;
  revision: string;
  view: DraftView;
  onCommit: () => void;
  onOpenCardFlow: () => void;
  onRevise: () => void;
  onRevisionChange: (value: string) => void;
  onViewChange: (view: DraftView) => void;
}) {
  if (detailLoading) return <LoadingBlock text="读取草稿详情..." />;
  if (!detail) return <PanelEmpty text="请选择一个草稿，或先在聊天里提交材料生成草稿。" />;

  return (
    <>
      <div className="shrink-0 border-b border-current/10 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              <TinyPill>{intentLabel(detail.user_intent)}</TinyPill>
              {detail.word_count > 0 && <TinyPill>{detail.word_count} 字</TinyPill>}
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
              {detail.title || "未命名草稿"}
            </h2>
            {detail.instruction && (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                用户要求：{detail.instruction}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <ActionButton
              onClick={onCommit}
              disabled={!OPEN_STATUSES.has(detail.status) || Boolean(actionLoading)}
              loading={actionLoading === "commit"}
            >
              确认入库
            </ActionButton>
            <button
              type="button"
              onClick={onOpenCardFlow}
              disabled={Boolean(actionLoading)}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-background/50 px-3 py-2 text-sm text-foreground transition hover:bg-primary/10 disabled:opacity-45"
            >
              <Sparkles className="h-4 w-4" />
              转知识卡片
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-current/10 bg-background/35 px-4 py-2">
        {[
          ["draft", "整理稿"],
          ["raw", "原文"],
          ["meta", "元信息"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onViewChange(key as DraftView)}
            className={cn(
              "rounded px-3 py-1.5 text-sm transition",
              view === key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {view === "draft" && (
          detail.draft_text ? (
            <Markdown content={detail.draft_text} />
          ) : (
            <PanelEmpty text="这个草稿还没有整理稿，可能只完成了原文提取。" />
          )
        )}
        {view === "raw" && (
          detail.raw_text ? (
            <pre className="whitespace-pre-wrap rounded-md border border-current/10 bg-background/50 p-4 text-sm leading-7 text-foreground">
              {detail.raw_text}
            </pre>
          ) : (
            <PanelEmpty text="没有保存原文内容。" />
          )
        )}
        {view === "meta" && <DraftMeta draft={detail} />}
      </div>

      <div className="shrink-0 border-t border-current/10 bg-background-base/90 p-3">
        <div className="flex flex-col gap-2 lg:flex-row">
          <textarea
            value={revision}
            onChange={(event) => onRevisionChange(event.target.value)}
            placeholder="写修改意见，比如：把第二部分展开，保留更多原文例子，删掉模板化表达..."
            className="min-h-20 flex-1 resize-none rounded-md border border-current/15 bg-background/70 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="button"
            onClick={onRevise}
            disabled={!revision.trim() || Boolean(actionLoading)}
            className="inline-flex min-h-20 items-center justify-center gap-2 rounded-md border border-primary/45 bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[0_12px_30px_rgba(0,0,0,0.22)] transition hover:brightness-110 disabled:border-current/10 disabled:bg-muted/40 disabled:text-muted-foreground"
          >
            {actionLoading === "revise" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            继续修改
          </button>
        </div>
      </div>
    </>
  );
}

function DraftMeta({ draft }: { draft: KnowledgeCaptureDraft }) {
  return (
    <div className="space-y-4">
      <InfoGrid
        rows={[
          ["状态", draft.status],
          ["用户意图", intentLabel(draft.user_intent)],
          ["来源类型", draft.source_type || "未记录"],
          ["来源", draft.source || "未记录"],
          ["创建时间", draft.created_at || "未记录"],
          ["更新时间", draft.updated_at || "未记录"],
          ["已入库 Capture", draft.committed_capture_id || "尚未入库"],
        ]}
      />
      {draft.tags.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold tracking-normal text-foreground">标签</h3>
          <div className="flex flex-wrap gap-2">
            {draft.tags.map((tag) => (
              <TinyPill key={tag}>{tag}</TinyPill>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold tracking-normal text-foreground">
          Capture Intent
        </h3>
        <pre className="overflow-x-auto rounded-md border border-current/10 bg-background/50 p-3 text-xs leading-5 text-muted-foreground">
          {JSON.stringify(draft.capture_intent, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function StatusInspector({
  answerDetail,
  connection,
  currentToolName,
  detail,
  mode,
  openCount,
  running,
  selection,
  toolsCount,
  turnIndex,
}: {
  answerDetail: KnowledgeReadingDraft | null;
  connection: string;
  currentToolName: string | null;
  detail: KnowledgeCaptureDraft | null;
  mode: WorkbenchMode;
  openCount: number;
  running: boolean;
  selection: WorkbenchSelection | null;
  toolsCount: number;
  turnIndex: number;
}) {
  const baseRows: Array<[string, string]> = [
    ["当前模式", modeLabel(mode)],
    ["连接状态", connection],
    ["运行状态", running ? "Hermes 正在处理" : "空闲"],
  ];
  if (currentToolName) {
    baseRows.push(["当前工具", currentToolName]);
  }
  baseRows.push(
    ["对话轮次", String(turnIndex)],
    ["待审草稿", String(openCount)],
    ["已记录工具调用", String(toolsCount)],
    ["当前选择", selection ? selectionLabel(selection) : "当前对话"],
  );

  return (
    <div className="space-y-3">
      <InfoGrid rows={baseRows} />
      {mode === "answer_draft_review" && answerDetail ? (
        <InfoGrid
          rows={[
            ["文稿状态", statusLabel(answerDetail.status)],
            ["文稿类型", answerDraftTypeLabel(answerDetail.output_type)],
            ["保存状态", answerDetail.status === "committed" ? "已保存到知识库" : "待审阅确认"],
            ["索引状态", answerDetail.status === "committed" ? "保存后会注册为可检索知识条目" : "确认保存后生成"],
            ["最近更新", answerDetail.updated_at || "未记录"],
          ]}
        />
      ) : detail ? (
        <InfoGrid
          rows={[
            ["草稿状态", statusLabel(detail.status)],
            ["材料类型", detail.source_type || "未记录"],
            ["入库状态", detail.committed_capture_id ? "已入库" : "未入库"],
            ["Capture ID", detail.committed_capture_id || "尚未生成"],
            ["索引状态", detail.committed_capture_id ? "已触发入库后维护；详细结果以工具记录为准" : "确认入库后生成"],
            ["Theme/Garden", "由工具返回的 Theme/Garden 同步结果会显示在工具页"],
            ["最近更新", detail.updated_at || "未记录"],
          ]}
        />
      ) : (
        <PanelEmpty text="选择材料草稿或文稿草稿后，这里会显示保存、入库和索引状态。" />
      )}
    </div>
  );
}

function InfoGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid gap-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-md border border-current/10 bg-background/45 p-3">
          <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words text-sm leading-5 text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-current/10 bg-background/50 px-2 py-1 text-xs text-muted-foreground">
      <CircleDot className="h-3.5 w-3.5 text-primary/80" />
      <span className="truncate">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function ActionButton({
  children,
  disabled,
  loading,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-primary/45 bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-[0_12px_30px_rgba(0,0,0,0.22)] transition hover:brightness-110 disabled:border-current/10 disabled:bg-muted/40 disabled:text-muted-foreground"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const open = OPEN_STATUSES.has(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[0.68rem] uppercase tracking-[0.12em]",
        open
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-current/10 bg-background/55 text-muted-foreground",
      )}
      title={status}
    >
      {statusLabel(status)}
    </span>
  );
}

function TinyPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-current/10 bg-background/55 px-2 py-0.5 text-[0.72rem] leading-5 text-muted-foreground">
      {children}
    </span>
  );
}

function LoadingBlock({ text }: { text: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
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

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isCommitDraftCommand(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "");
  if (!normalized) return false;
  return /^(存库|入库|保存|确认入库|确认存库|存入知识库|保存到知识库|把这个草稿入库|这个草稿入库|满意存库|可以存库)[。.!！]*$/.test(normalized);
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

function gatewayMessagesToWorkbench(messages: GatewayResumeMessage[]): KnowledgeMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message, index) => ({
      id: `history-${index}-${Date.now()}`,
      role: (message.role === "assistant" ? "assistant" : "user") as KnowledgeMessage["role"],
      text: message.text || "",
      createdAt: Date.now() - (messages.length - index) * 1000,
      status: "complete" as const,
    }))
    .filter((message) => message.text.trim());
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex min-h-full items-center justify-center py-10">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
          <MessageSquareText className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold tracking-normal text-foreground">
          在电脑上完整查看 Hermes 的回答
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          这里不会像微信一样压缩成长短句，适合让 RAG 展开依据、让 Capture 展示完整草稿，或者观察工具调用是否按预期发生。
        </p>
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
  streaming,
}: {
  message: KnowledgeMessage;
  onSaveAnswer?: (message: KnowledgeMessage, outputType: AnswerOutputType) => void;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <article
      className={cn(
        "flex",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "min-w-0 rounded-lg border px-4 py-3 shadow-sm",
          isUser
            ? "max-w-[min(760px,85%)] border-primary/25 bg-primary/12"
            : "w-full border-current/10 bg-background/65",
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
                onClick={() => onSaveAnswer(message, "local_learning_note")}
                className="rounded border border-current/10 px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
              >
                存为笔记
              </button>
              <button
                type="button"
                onClick={() => onSaveAnswer(message, "knowledge_card")}
                className="rounded border border-current/10 px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
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
          <Markdown
            content={stripTrailingSourceSection(message.text)}
            streaming={streaming}
          />
        )}
      </div>
    </article>
  );
}

/**
 * Remove the trailing "来源" / "参考来源" / "References" section from an
 * assistant message so it is only shown in the inspector panel, not inline.
 */
function stripTrailingSourceSection(text: string): string {
  const lines = text.split("\n");
  let cutIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      /^#{0,3}\s*(参考来源|来源|引用|references?)\s*[:：]?$/i.test(trimmed)
    ) {
      cutIndex = i;
    }
  }

  if (cutIndex < 0) return text;
  // Trim trailing blank lines before the source heading
  while (cutIndex > 0 && lines[cutIndex - 1].trim() === "") cutIndex--;
  return lines.slice(0, cutIndex).join("\n");
}

function InspectorPanel({
  children,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-current/10 bg-background-base/75 shadow-[0_18px_60px_rgba(0,0,0,0.18)] backdrop-blur">
      <header className="flex shrink-0 items-center gap-2 border-b border-current/10 px-3 py-2.5">
        <Icon className="h-4 w-4 text-primary/80" />
        <h2 className="text-sm font-semibold tracking-normal text-foreground">
          {title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

function PanelEmpty({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-current/15 bg-background/35 px-3 py-4 text-sm leading-6 text-muted-foreground">
      {text}
    </div>
  );
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

function intentLabel(intent: string): string {
  return ({
    verbatim_full_text: "全文保存",
    full_text: "全文保存",
    summary: "精炼总结",
    focus_extract: "重点提取",
    enhanced_note: "原文增强",
  } as Record<string, string>)[intent] ?? (intent || "未识别");
}

function answerDraftTypeLabel(type: string): string {
  return ({
    local_learning_note: "学习笔记",
    knowledge_card: "知识卡片",
    enhance_capture: "主笔记增强",
  } as Record<string, string>)[type] ?? "回答沉淀";
}

function statusLabel(status: string): string {
  return ({
    open: "待保存",
    raw_extracted: "已提取",
    draft_ready: "待审阅",
    revision_requested: "修改中",
    draft_incomplete: "未完成",
    committed: "已入库",
  } as Record<string, string>)[status] ?? (status || "未知");
}

function modeLabel(mode: WorkbenchMode): string {
  return ({
    chat: "对话",
    draft_review: "草稿审阅",
    answer_draft_review: "回答沉淀",
    source: "原文查看",
    result: "结果报告",
  } as Record<WorkbenchMode, string>)[mode];
}

function selectionLabel(selection: WorkbenchSelection): string {
  if (selection.type === "conversation") return "当前对话";
  if (selection.type === "draft") return "草稿审阅";
  if (selection.type === "material") return "材料查看";
  return "知识卡片";
}

function sourceTypeColor(sourceType: string): string {
  const t = sourceType.toLowerCase();
  if (t.includes("capture") || t.includes("note")) return "bg-blue-500/15 text-blue-400";
  if (t.includes("garden") || t.includes("card")) return "bg-emerald-500/15 text-emerald-400";
  if (t.includes("theme")) return "bg-purple-500/15 text-purple-400";
  if (t.includes("url") || t.includes("link")) return "bg-gray-500/15 text-gray-400";
  return "bg-muted text-muted-foreground";
}

function sourceTypeLabel(sourceType: string): string {
  const t = sourceType.toLowerCase();
  if (t.includes("capture")) return "capture";
  if (t.includes("garden") || t.includes("card")) return "garden";
  if (t.includes("theme")) return "theme";
  if (t.includes("learning")) return "note";
  if (t.includes("url") || t.includes("link")) return "url";
  return sourceType;
}
