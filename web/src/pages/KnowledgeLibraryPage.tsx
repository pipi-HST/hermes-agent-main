import {
  type ChangeEvent,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Eye,
  ExternalLink,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  Layers3,
  Loader2,
  Minimize2,
  MoreHorizontal,
  NotebookPen,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Send,
  SquareStop,
  Trash2,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  createAiOperationId,
  type KnowledgeCaptureDraft,
  type KnowledgeGardenDraftResponse,
  type KnowledgeLibraryDependencies,
  type KnowledgeLibraryDeleteResponse,
  type KnowledgeLibraryFolder,
  type KnowledgeLibraryItem,
  type KnowledgeLibrarySelectionChatResponse,
  type KnowledgeLibrarySelectionChatStreamEvent,
  type KnowledgeLibrarySmartView,
  type KnowledgeChatHistoryMessage,
  type KnowledgeResearchMode,
  type KnowledgeResearchSource,
  type KnowledgeResearchTrace,
} from "@/lib/api";
import { cn, isoTimeAgo } from "@/lib/utils";
import { ResizableRail, readStoredWidth } from "@/components/ResizableRail";
import { KnowledgeLibraryHeader } from "@/pages/KnowledgeLibraryHeader";
import { useWorkspaceChrome } from "@/contexts/WorkspaceChromeContext";
import {
  EditableCaptureWorkbench,
  type EditableCardCommitStatus,
  type EditableCaptureStatus,
} from "@/pages/knowledge-chat/EditableCaptureWorkbench";
import { Markdown } from "@/components/Markdown";
import { KnowledgeAnswerView } from "@/components/KnowledgeAnswerView";
import {
  analyzeKnowledgeOutlineMarkdown,
  repairKnowledgeOutlineMarkdown,
} from "@/lib/markdownNavigation";

type LibrarySelection =
  | { type: "all"; value: "all" }
  | { type: "folder"; value: string }
  | { type: "view"; value: string };

type LibraryMode = "files" | "paste";
type LibraryWorkbenchMode = "browse" | "edit";
type StatusFilter = "all" | "draft" | "in_library" | "searchable" | "cards";
type ArticleAIPanelMode = "collapsed" | "assist" | "focus";
type AiOperationState = { id: string; label: string; controller: AbortController; stopping: boolean } | null;

function isAiCancelledResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.cancelled === true || record.status === "cancelled";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface ArticleSelectionContext {
  selectedText: string;
  surroundingBefore: string;
  surroundingAfter: string;
  headingPath: string[];
  selectionStart?: number;
  selectionEnd?: number;
  selectionConfidence: "offset" | "text_only" | "none";
}

interface ArticleAiRequestContext {
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

function readSearchBackend(...statuses: unknown[]): string | undefined {
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


interface ArticleChatMessage {
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

type ArticleChatMessagesByMode = Record<"current_article_only" | "local_web", ArticleChatMessage[]>;

const EMPTY_ARTICLE_CHAT_MESSAGES: ArticleChatMessagesByMode = {
  current_article_only: [],
  local_web: [],
};

function articleChatModeKey(mode: KnowledgeResearchMode): keyof ArticleChatMessagesByMode {
  return mode === "local_web" ? "local_web" : "current_article_only";
}

const DEFAULT_SELECTION: LibrarySelection = { type: "all", value: "all" };
const DEFAULT_EXPANDED_FOLDERS = new Set(["Inbox"]);

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "in_library", label: "已入库" },
  { key: "searchable", label: "可检索" },
  { key: "cards", label: "有卡片" },
];

const KNOWLEDGE_LEFT_WIDTH_KEY = "hermes.knowledgeLibrary.leftWidth";
const KNOWLEDGE_LEFT_COLLAPSED_KEY = "hermes.knowledgeLibrary.leftPaneCollapsed";
const KNOWLEDGE_AI_WIDTH_KEY = "hermes.knowledgeLibrary.aiWidth";
const KNOWLEDGE_AI_FOCUS_WIDTH_KEY = "hermes.knowledgeLibrary.aiFocusWidth";
const DEFAULT_KNOWLEDGE_LEFT_WIDTH = 360;
const DEFAULT_KNOWLEDGE_AI_WIDTH = 380;
const DEFAULT_KNOWLEDGE_AI_FOCUS_WIDTH = 520;
const MAX_SELECTION_SEARCH_CHARS = 1000;
const ARTICLE_AI_STREAM_TIMEOUT_MS = 100_000;
const SELECTION_TOO_LONG_MESSAGE = "选区超过 1000 字，当前不支持基于超长选区检索。请缩短选区后再试。";
const LIBRARY_NOT_FOUND_PATTERNS = [
  "Library capture not found",
  "Library draft not found",
  "Capture not found",
  "Capture draft not found",
];

const ARTICLE_AI_STARTERS: Array<{ label: string; prompt: string }> = [
  { label: "总结核心结论", prompt: "请用三句话总结这篇资料的核心结论，并指出它回答了什么真问题。" },
  { label: "讲懂不懂的段落", prompt: "请用通俗的语言讲懂这篇资料里最难理解的概念，并举一个实际例子。" },
  { label: "提炼 3 张卡片", prompt: "请把这篇资料提炼成 3 张可复用的知识卡片，每张都说明适用场景与边界。" },
];

function isLibraryNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith("404:") && LIBRARY_NOT_FOUND_PATTERNS.some((pattern) => message.includes(pattern));
}

export default function KnowledgeLibraryPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { sidebarCollapsed, setSidebarCollapsed } = useWorkspaceChrome();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<LibraryMode>(
    searchParams.get("mode") === "paste" ? "paste" : "files",
  );
  const [folders, setFolders] = useState<KnowledgeLibraryFolder[]>([]);
  const [views, setViews] = useState<KnowledgeLibrarySmartView[]>([]);
  const [allItems, setAllItems] = useState<KnowledgeLibraryItem[]>([]);
  const [items, setItems] = useState<KnowledgeLibraryItem[]>([]);
  const [selection, setSelection] = useState<LibrarySelection>(DEFAULT_SELECTION);
  const [selectedKey, setSelectedKey] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED_FOLDERS),
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [detail, setDetail] = useState<KnowledgeLibraryItem | null>(null);
  const [query, setQuery] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState("");
  const [renameFolderName, setRenameFolderName] = useState("");
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [loadingItems, setLoadingItems] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [cardGenerating, setCardGenerating] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderRenaming, setFolderRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [aiOperation, setAiOperation] = useState<AiOperationState>(null);
  const cancelledAiOperationsRef = useRef<Set<string>>(new Set());
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftFolder, setDraftFolder] = useState("Inbox");
  const [workbenchMode, setWorkbenchMode] = useState<LibraryWorkbenchMode>("browse");
  const [aiPanelMode, setAiPanelMode] = useState<ArticleAIPanelMode>("assist");
  const [leftPaneWidth, setLeftPaneWidth] = useState(() =>
    readStoredWidth(KNOWLEDGE_LEFT_WIDTH_KEY, DEFAULT_KNOWLEDGE_LEFT_WIDTH),
  );
  const [aiPaneWidth, setAiPaneWidth] = useState(() =>
    readStoredWidth(KNOWLEDGE_AI_WIDTH_KEY, DEFAULT_KNOWLEDGE_AI_WIDTH),
  );
  const [aiFocusPaneWidth, setAiFocusPaneWidth] = useState(() =>
    readStoredWidth(KNOWLEDGE_AI_FOCUS_WIDTH_KEY, DEFAULT_KNOWLEDGE_AI_FOCUS_WIDTH),
  );
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(() => (
    window.localStorage.getItem(KNOWLEDGE_LEFT_COLLAPSED_KEY) === "true"
  ));
  const [readingFullscreen, setReadingFullscreen] = useState(false);
  const libraryLayoutRef = useRef<HTMLDivElement | null>(null);
  const articleLayoutRef = useRef<HTMLDivElement | null>(null);
  const lastOpenAiPanelModeRef = useRef<ArticleAIPanelMode>("assist");
  const [selectionContext, setSelectionContext] = useState<ArticleSelectionContext | null>(null);
  const [chatMessagesByMode, setChatMessagesByMode] = useState<ArticleChatMessagesByMode>(EMPTY_ARTICLE_CHAT_MESSAGES);
  const [chatQuestion, setChatQuestion] = useState("");
  const [articleResearchMode, setArticleResearchMode] = useState<KnowledgeResearchMode>("current_article_only");
  const [historySummary, setHistorySummary] = useState("");
  const [historySummaryVersion, setHistorySummaryVersion] = useState(0);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const chatStreamAbortRef = useRef<AbortController | null>(null);
  const chatStreamAssistantIdRef = useRef("");
  const [savingArticleAnswerId, setSavingArticleAnswerId] = useState("");
  const [editableContent, setEditableContent] = useState("");
  const [editableTitle, setEditableTitle] = useState("");
  const [editableTitleSource, setEditableTitleSource] = useState<"ai" | "user">("ai");
  const [editableSummary, setEditableSummary] = useState("");
  const [editableTagsText, setEditableTagsText] = useState("");
  const [editableSource, setEditableSource] = useState("");
  const [editableFolder, setEditableFolder] = useState("Inbox");
  const [editableFolderSuggestionMode, setEditableFolderSuggestionMode] = useState<"existing" | "new">("existing");
  const [editableFolderSuggestionReason, setEditableFolderSuggestionReason] = useState("");
  const [editableGenerateCard, setEditableGenerateCard] = useState(false);
  const [editableCardCommitStatus, setEditableCardCommitStatus] = useState<EditableCardCommitStatus>("idle");
  const [editableCardReason, setEditableCardReason] = useState("");
  const [editableCardSuggestionsText, setEditableCardSuggestionsText] = useState("");
  const [editableDraft, setEditableDraft] = useState<KnowledgeCaptureDraft | null>(null);
  const [editableStatus, setEditableStatus] = useState<EditableCaptureStatus>("empty");
  const [editableProgressMessage, setEditableProgressMessage] = useState("");
  const [editableError, setEditableError] = useState("");
  const chatMessages = chatMessagesByMode[articleResearchMode === "local_web" ? "local_web" : "current_article_only"];
  const setChatMessagesForMode = useCallback((
    mode: KnowledgeResearchMode,
    updater: (messages: ArticleChatMessage[]) => ArticleChatMessage[],
  ) => {
    const key = articleChatModeKey(mode);
    setChatMessagesByMode((current) => ({
      ...current,
      [key]: updater(current[key] || []),
    }));
  }, []);

  const selectedFolder = selection.type === "folder" ? selection.value : "";
  const selectedView = selection.type === "view" ? selection.value : "";
  const folderOptions = useMemo(
    () => folders.map((folder) => ({ path: folder.path, name: folder.name })),
    [folders],
  );
  const visibleFolderPaths = useMemo(
    () => folders.map((folder) => folder.path).filter(Boolean),
    [folders],
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
    setNotice("已请求停止。你可以继续编辑或重试。");
    setEditableProgressMessage("已请求停止，可继续编辑或重试");
    setEditableStatus((current) => (
      current === "organizing" ? "editing" : current === "committing" ? "ready_to_commit" : current
    ));
    void api.cancelKnowledgeAiOperation(aiOperation.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [aiOperation]);
  const itemsByFolder = useMemo(() => groupItemsByFolder(allItems), [allItems]);
  const visibleItems = useMemo(
    () => items.filter((item) => matchesStatusFilter(item, statusFilter)),
    [items, statusFilter],
  );
  const selectedItem = useMemo(
    () => items.find((item) => itemKey(item) === selectedKey)
      ?? allItems.find((item) => itemKey(item) === selectedKey)
      ?? null,
    [allItems, items, selectedKey],
  );
  const selectionTitle = useMemo(
    () => selectionLabel(selection, views),
    [selection, views],
  );
  const stats = useMemo(() => ({
    all: allItems.length,
    drafts: allItems.filter((item) => item.kind === "capture_draft").length,
    inLibrary: allItems.filter((item) => item.kind === "capture").length,
    searchable: allItems.filter((item) => item.indexed).length,
    cards: allItems.filter((item) => item.garden_card_count > 0).length,
  }), [allItems]);
  const detailDirty = useMemo(() => {
    if (mode !== "files" || !detail) return false;
    return (
      draftTitle !== detail.title
      || draftBody !== (detail.body || detail.preview || "")
      || draftFolder !== (detail.folder_path || "Inbox")
    );
  }, [detail, draftBody, draftFolder, draftTitle, mode]);
  const editableDirty = useMemo(() => {
    if (mode !== "paste" || editableStatus === "empty" || editableStatus === "committed") {
      return false;
    }
    return Boolean(
      editableDraft?.id
      || editableContent.trim()
      || editableTitle.trim()
      || editableSummary.trim()
      || editableTagsText.trim()
      || editableFolderSuggestionReason.trim()
      || editableCardReason.trim()
      || editableCardSuggestionsText.trim()
    );
  }, [
    editableCardReason,
    editableCardSuggestionsText,
    editableContent,
    editableDraft,
    editableFolderSuggestionReason,
    editableStatus,
    editableSummary,
    editableTagsText,
    editableTitle,
    mode,
  ]);
  const hasUnsavedChanges = detailDirty || editableDirty;
  const aiPanelOpen = aiPanelMode !== "collapsed";
  const allSidebarsCollapsed = sidebarCollapsed && leftPaneCollapsed && aiPanelMode === "collapsed";
  const canEnterReadingFullscreen = mode === "files" && Boolean(detail) && workbenchMode === "browse";
  const aiPanelWidth = aiPanelMode === "focus" ? aiFocusPaneWidth : aiPaneWidth;
  const libraryLayoutStyle = {
    "--knowledge-left-width": `${leftPaneWidth}px`,
  } as CSSProperties;
  const articleLayoutStyle = {
    "--knowledge-ai-width": `${aiPanelWidth}px`,
  } as CSSProperties;
  const confirmLeaveCurrentWork = useCallback(() => {
    if (!hasUnsavedChanges) return true;
    return window.confirm("当前文件有未保存更改，确定离开吗？");
  }, [hasUnsavedChanges]);

  useEffect(() => {
    window.localStorage.setItem(KNOWLEDGE_LEFT_COLLAPSED_KEY, leftPaneCollapsed ? "true" : "false");
  }, [leftPaneCollapsed]);

  useEffect(() => {
    if (aiPanelMode !== "collapsed") {
      lastOpenAiPanelModeRef.current = aiPanelMode;
    }
  }, [aiPanelMode]);

  useEffect(() => {
    if (!readingFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReadingFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [readingFullscreen]);

  const toggleAllSidebars = useCallback(() => {
    if (allSidebarsCollapsed) {
      setSidebarCollapsed(false);
      setLeftPaneCollapsed(false);
      setViewMenuOpen(false);
      return;
    }
    setSidebarCollapsed(true);
    setLeftPaneCollapsed(true);
    if (aiPanelMode !== "collapsed") {
      lastOpenAiPanelModeRef.current = aiPanelMode;
      setAiPanelMode("collapsed");
    }
    setViewMenuOpen(false);
  }, [aiPanelMode, allSidebarsCollapsed, setSidebarCollapsed]);

  const toggleWorkspaceNavigation = useCallback(() => {
    setSidebarCollapsed((current) => !current);
    setViewMenuOpen(false);
  }, [setSidebarCollapsed]);

  const toggleKnowledgeLeftPane = useCallback(() => {
    setLeftPaneCollapsed((current) => !current);
    setViewMenuOpen(false);
  }, []);

  const toggleArticleAiPanel = useCallback(() => {
    setAiPanelMode((current) => current === "collapsed" ? lastOpenAiPanelModeRef.current : "collapsed");
    setViewMenuOpen(false);
  }, []);

  const enterReadingFullscreen = useCallback(() => {
    if (canEnterReadingFullscreen) {
      setReadingFullscreen(true);
    }
    setViewMenuOpen(false);
  }, [canEnterReadingFullscreen]);

  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    try {
      const payload = await api.getKnowledgeLibraryFolders();
      setFolders(payload.folders);
      setViews(payload.smart_views);
      setExpandedFolders((current) => {
        const next = new Set(current);
        if (selection.type === "folder") next.add(selection.value);
        return next;
      });
      if (
        selection.type === "folder"
        && !payload.folders.some((folder) => folder.path === selection.value)
      ) {
        setSelection(DEFAULT_SELECTION);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFolders(false);
    }
  }, [selection]);

  const loadAllItems = useCallback(async () => {
    try {
      const payload = await api.getKnowledgeLibraryItems({ limit: 500 });
      setAllItems(payload.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAllItems([]);
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    setError("");
    try {
      const payload = await api.getKnowledgeLibraryItems({
        folder: selectedFolder,
        view: selectedView,
        search: query,
        limit: 300,
      });
      setItems(payload.items);
      setSelectedKey((current) => {
        if (current && payload.items.some((item) => itemKey(item) === current)) return current;
        return payload.items[0] ? itemKey(payload.items[0]) : "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
      setSelectedKey("");
    } finally {
      setLoadingItems(false);
    }
  }, [query, selectedFolder, selectedView]);

  const loadDetail = useCallback(async (item: KnowledgeLibraryItem | null) => {
    if (!item) {
      setDetail(null);
      setDraftTitle("");
      setDraftBody("");
      setDraftFolder(selectedFolder || "Inbox");
      return;
    }
    setLoadingDetail(true);
    setError("");
    try {
      const payload = await api.getKnowledgeLibraryItem(item.kind, item.id);
      setDetail(payload.item);
      setDraftTitle(payload.item.title);
      setDraftBody(payload.item.body || payload.item.preview || "");
      setDraftFolder(payload.item.folder_path || "Inbox");
    } catch (err) {
      if (isLibraryNotFoundError(err)) {
        setDetail(null);
        setSelectedKey("");
        setDraftTitle("");
        setDraftBody("");
        setDraftFolder(selectedFolder || "Inbox");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedFolder]);

  useEffect(() => {
    void loadFolders();
    void loadAllItems();
  }, [loadAllItems, loadFolders]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    void loadDetail(selectedItem);
  }, [loadDetail, selectedItem]);

  useEffect(() => {
    chatStreamAbortRef.current?.abort();
    chatStreamAbortRef.current = null;
    chatStreamAssistantIdRef.current = "";
    setSelectionContext(null);
    setChatMessagesByMode({ ...EMPTY_ARTICLE_CHAT_MESSAGES });
    setHistorySummary("");
    setHistorySummaryVersion(0);
    setChatQuestion("");
    setChatError("");
    setChatLoading(false);
  }, [selectedKey]);

  useEffect(() => {
    return () => {
      chatStreamAbortRef.current?.abort();
      chatStreamAssistantIdRef.current = "";
    };
  }, []);

  useEffect(() => {
    if (searchParams.get("mode") === "paste") {
      setMode("paste");
    }
  }, [searchParams]);

  useEffect(() => {
    const rawKind = searchParams.get("kind");
    const itemId = searchParams.get("item");
    const requestedMode = searchParams.get("mode");
    const kind = rawKind === "capture" || rawKind === "capture_draft" ? rawKind : "";
    if (!kind || !itemId) return;
    if (!allItems.length && loadingItems) return;

    const item = allItems.find((entry) => entry.kind === kind && entry.id === itemId);
    const clearRouteParams = () => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("kind");
        next.delete("item");
        next.delete("mode");
        return next;
      }, { replace: true });
    };

    if (!item) {
      setSelectedKey("");
      setDetail(null);
      setNotice("目标文件已不存在或已被删除。");
      clearRouteParams();
      return;
    }

    const folder = item.folder_path || "Inbox";
    setSelection(item.folder_path ? { type: "folder", value: folder } : DEFAULT_SELECTION);
    setExpandedFolders((current) => new Set(current).add(folder));
    setStatusFilter("all");
    setMode("files");
    setWorkbenchMode(requestedMode === "edit" ? "edit" : "browse");
    setSelectedKey(itemKey(item));
    void loadDetail(item);
    clearRouteParams();
  }, [allItems, loadDetail, loadingItems, searchParams, setSearchParams]);

  useEffect(() => {
    if (mode !== "files") return;
    if (!visibleItems.length) {
      if (selectedItem) return;
      setSelectedKey("");
      return;
    }
    if (selectedItem) return;
    if (!visibleItems.some((item) => itemKey(item) === selectedKey)) {
      setSelectedKey(itemKey(visibleItems[0]));
    }
  }, [mode, selectedItem, selectedKey, visibleItems]);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadFolders(), loadAllItems(), loadItems()]);
  }, [loadAllItems, loadFolders, loadItems]);

  const switchMode = useCallback((nextMode: LibraryMode) => {
    setMode(nextMode);
    if (nextMode === "files") setWorkbenchMode("browse");
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (nextMode === "paste") {
        next.set("mode", "paste");
      } else {
        next.delete("mode");
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const selectAllFiles = useCallback(() => {
    if (!confirmLeaveCurrentWork()) return;
    setSelection(DEFAULT_SELECTION);
    setStatusFilter("all");
    switchMode("files");
  }, [confirmLeaveCurrentWork, switchMode]);

  const selectView = useCallback((view: string, filter: StatusFilter = "all") => {
    if (!confirmLeaveCurrentWork()) return;
    setSelection({ type: "view", value: view });
    setStatusFilter(filter);
    switchMode("files");
  }, [confirmLeaveCurrentWork, switchMode]);

  const selectFolder = useCallback((folder: string) => {
    if (!confirmLeaveCurrentWork()) return;
    setSelection({ type: "folder", value: folder });
    setExpandedFolders((current) => new Set(current).add(folder));
    setStatusFilter("all");
    switchMode("files");
  }, [confirmLeaveCurrentWork, switchMode]);

  const toggleFolder = useCallback((folder: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }, []);

  const applyEditableDraftSuggestion = useCallback((
    draft: KnowledgeCaptureDraft,
    options: { fallbackContent: string; fallbackFolder: string },
  ) => {
    const folderSuggestion = editableFolderSuggestion(draft.capture_intent);
    const cardSuggestion = editableCardSuggestion(draft.capture_intent);
    const folderPath = folderSuggestion.folder_path || stringValue(draft.capture_intent?.folder_path) || options.fallbackFolder || "Inbox";
    setEditableDraft(draft);
    setEditableContent(draft.draft_text || options.fallbackContent);
    setEditableTitle(draft.title || "");
    setEditableTitleSource(editableDraftTitleSource(draft));
    setEditableSummary(draft.summary || "");
    setEditableTagsText((draft.tags || []).join(", "));
    setEditableFolder(String(folderPath));
    setEditableFolderSuggestionMode(folderSuggestion.mode === "new" ? "new" : "existing");
    setEditableFolderSuggestionReason(folderSuggestion.reason || "");
    setEditableGenerateCard(Boolean(cardSuggestion.should_generate));
    setEditableCardReason(cardSuggestion.reason || "");
    setEditableCardSuggestionsText(formatEditableCardSuggestions(cardSuggestion.cards));
  }, []);

  const openItemFromSidebar = useCallback((item: KnowledgeLibraryItem) => {
    if (!confirmLeaveCurrentWork()) return;
    const folder = item.folder_path || "Inbox";
    setSelection({ type: "folder", value: folder });
    setExpandedFolders((current) => new Set(current).add(folder));
    setStatusFilter("all");
    setSelectedKey(itemKey(item));
    setWorkbenchMode("browse");
    switchMode("files");
    void loadDetail(item);
  }, [confirmLeaveCurrentWork, loadDetail, switchMode]);

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setCreatingFolder(true);
    setError("");
    try {
      const payload = await api.createKnowledgeLibraryFolder(name);
      setNewFolderName("");
      setSelection({ type: "folder", value: payload.folder.path });
      setExpandedFolders((current) => new Set(current).add(payload.folder.path));
      await loadFolders();
      setNotice(`已新建文件夹：${payload.folder.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingFolder(false);
    }
  }, [loadFolders, newFolderName]);

  const startRenameFolder = useCallback((folder: KnowledgeLibraryFolder) => {
    if (folder.path === "Inbox") return;
    setRenamingFolder(folder.path);
    setRenameFolderName(folder.name);
    setError("");
  }, []);

  const cancelRenameFolder = useCallback(() => {
    setRenamingFolder("");
    setRenameFolderName("");
  }, []);

  const renameFolder = useCallback(async () => {
    const oldName = renamingFolder;
    const newName = renameFolderName.trim();
    if (!oldName || !newName) return;
    if (oldName === newName) {
      cancelRenameFolder();
      return;
    }
    setFolderRenaming(true);
    setError("");
    setNotice("");
    try {
      const payload = await api.updateKnowledgeLibraryFolder(oldName, newName);
      setSelection((current) => (
        current.type === "folder" && current.value === oldName
          ? { type: "folder", value: payload.folder.path }
          : current
      ));
      setExpandedFolders((current) => {
        const next = new Set(current);
        next.delete(oldName);
        next.add(payload.folder.path);
        return next;
      });
      cancelRenameFolder();
      await refreshAll();
      setNotice(`已重命名文件夹：${oldName} -> ${payload.folder.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderRenaming(false);
    }
  }, [cancelRenameFolder, refreshAll, renameFolderName, renamingFolder]);

  const startEditableEntry = useCallback((sourceLabel = "") => {
    if (!confirmLeaveCurrentWork()) return;
    const folder = selectedFolder || draftFolder || "Inbox";
    setError("");
    setNotice("");
    setEditableDraft(null);
    setEditableContent("");
    setEditableTitle("");
    setEditableTitleSource("ai");
    setEditableSummary("");
    setEditableTagsText("");
    setEditableSource(sourceLabel);
    setEditableFolder(folder);
    setEditableFolderSuggestionMode("existing");
    setEditableFolderSuggestionReason("");
    setEditableGenerateCard(false);
    setEditableCardCommitStatus("idle");
    setEditableCardReason("");
    setEditableCardSuggestionsText("");
    setEditableError("");
    setEditableStatus("empty");
    setNewMenuOpen(false);
    switchMode("paste");
  }, [confirmLeaveCurrentWork, draftFolder, selectedFolder, switchMode]);

  const createKnowledgeFile = useCallback(() => {
    startEditableEntry("");
  }, [startEditableEntry]);

  const importContent = useCallback(() => {
    if (!confirmLeaveCurrentWork()) return;
    setNewMenuOpen(false);
    importInputRef.current?.click();
  }, [confirmLeaveCurrentWork]);

  const handleImportContent = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const content = await file.text();
      const title = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
      setEditableDraft(null);
      setEditableContent(content);
      setEditableTitle(title);
      setEditableTitleSource("ai");
      setEditableSummary("");
      setEditableTagsText("");
      setEditableSource(file.name);
      setEditableFolder(selectedFolder || draftFolder || "Inbox");
      setEditableFolderSuggestionMode("existing");
      setEditableFolderSuggestionReason("");
      setEditableGenerateCard(false);
      setEditableCardCommitStatus("idle");
      setEditableCardReason("");
      setEditableCardSuggestionsText("");
      setEditableError("");
      setEditableStatus(content.trim() ? "editing" : "empty");
      switchMode("paste");
      setNotice(`已导入内容：${file.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [draftFolder, selectedFolder, switchMode]);

  const saveDetail = useCallback(async (options: { refresh?: boolean; silent?: boolean } = {}) => {
    if (!detail) return false;
    setSaving(true);
    setError("");
    if (!options.silent) setNotice("");
    try {
      let bodyToSave = draftBody;
      const outlineAnalysis = analyzeKnowledgeOutlineMarkdown(bodyToSave);
      if (outlineAnalysis.missing.length) {
        const confirmed = window.confirm(
          `发现 ${outlineAnalysis.missing.length} 个目录纲要条目无法跳转，是否自动补齐标题后保存？`,
        );
        if (!confirmed) return false;
        bodyToSave = repairKnowledgeOutlineMarkdown(bodyToSave);
        setDraftBody(bodyToSave);
      }
      if (detail.kind === "capture") {
        await api.updateKnowledgeCapture(detail.id, {
          title: draftTitle,
          body: bodyToSave,
          folder_path: draftFolder,
        });
        await loadDetail(detail);
      } else {
        const payload = await api.updateKnowledgeLibraryItem(detail.kind, detail.id, {
          title: draftTitle,
          body: bodyToSave,
          folder_path: draftFolder,
        });
        setDetail(payload.item);
        setSelectedKey(itemKey(payload.item));
      }
      if (options.refresh !== false) await refreshAll();
      if (!options.silent) setNotice("已保存。");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [detail, draftBody, draftFolder, draftTitle, loadDetail, refreshAll]);

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
      return { generated: false, error: "入库成功，但没有拿到 Capture ID。" };
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
    } catch (err) {
      return {
        generated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, []);

  const commitDraft = useCallback(async () => {
    if (!detail || detail.kind !== "capture_draft") return;
    const operation = beginAiOperation("library-capture-commit");
    setCommitting(true);
    setError("");
    setNotice("正在保存草稿...");
    try {
      const saved = await saveDetail({ refresh: false, silent: true });
      if (!saved) return;
      const draftBeforeCommit = (await api.getKnowledgeCaptureDraft(detail.id)).draft;
      const cardSuggestion = editableCardSuggestion(draftBeforeCommit.capture_intent);
      setNotice("正在写入知识库文件...");
      const commitResult = await api.commitKnowledgeCaptureDraft(detail.id, { operationId: operation.operationId });
      if (isAiCancelledResult(commitResult)) {
        setNotice("已停止。草稿仍保留，可继续编辑或重试入库。");
        return;
      }
      setNotice("正在重建索引和大纲...");
      const payload = await api.getKnowledgeCaptureDraft(detail.id);
      const cardResult = await maybeGenerateGardenCardAfterCommit({
        draft: payload.draft,
        commitResult,
        shouldGenerate: cardSuggestion.should_generate,
        reason: cardSuggestion.reason,
        suggestionsText: formatEditableCardSuggestions(cardSuggestion.cards),
        onStage: setNotice,
        operationId: operation.operationId,
      });
      await refreshAll();
      if (cardResult.generated) {
        setNotice("已入库并生成知识卡片。");
      } else if (cardResult.error) {
        setNotice(`已入库，但知识卡片生成失败：${cardResult.error}`);
      } else {
        setNotice("入库完成。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
      operation.finish();
    }
  }, [beginAiOperation, detail, maybeGenerateGardenCardAfterCommit, refreshAll, saveDetail]);

  const deleteDetail = useCallback(async () => {
    if (!detail) return;
    setDeleting(true);
    setError("");
    setNotice("");
    try {
      const dependencies = detail.kind === "capture"
        ? (await api.getKnowledgeLibraryItemDependencies(detail.kind, detail.id)).dependencies
        : undefined;
      const confirmed = window.confirm(libraryDeleteConfirmMessage(detail, dependencies));
      if (!confirmed) return;
      const result = await api.deleteKnowledgeLibraryItem(detail.kind, detail.id);
      setSelectedKey("");
      setDetail(null);
      await refreshAll();
      setNotice(
        detail.kind === "capture"
          ? libraryDeleteNotice(result)
          : "已删除草稿。",
      );
    } catch (err) {
      if (isLibraryNotFoundError(err)) {
        setSelectedKey("");
        setDetail(null);
        await refreshAll();
        setNotice("文件已删除。");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [detail, refreshAll]);

  const deleteDetailPermanent = useCallback(async () => {
    if (!detail || detail.kind !== "capture") return;
    setDeleting(true);
    setError("");
    setNotice("");
    try {
      const dependencies = (await api.getKnowledgeLibraryItemDependencies(detail.kind, detail.id)).dependencies;
      if (libraryHasBlockingDependencies(dependencies)) {
        setError(libraryPermanentDeleteBlockedMessage(detail, dependencies));
        return;
      }
      const confirmed = window.confirm(libraryPermanentDeleteConfirmMessage(detail, dependencies));
      if (!confirmed) return;
      const result = await api.deleteKnowledgeLibraryItemPermanent(detail.kind, detail.id);
      setSelectedKey("");
      setDetail(null);
      await refreshAll();
      setNotice(libraryPermanentDeleteNotice(result));
    } catch (err) {
      if (isLibraryNotFoundError(err)) {
        setSelectedKey("");
        setDetail(null);
        await refreshAll();
        setNotice("文件已彻底删除。");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [detail, refreshAll]);

  const openDetailLocal = useCallback(async () => {
    if (!detail || detail.kind !== "capture" || !detail.file_path) return;
    setError("");
    setNotice("");
    try {
      const result = await api.openKnowledgeLibraryItemLocal(detail.kind, detail.id);
      setNotice(`已用本地默认 App 打开：${result.path}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [detail]);

  const generateCard = useCallback(async () => {
    if (!detail || detail.kind !== "capture") return;
    const operation = beginAiOperation("library-card");
    setCardGenerating(true);
    setError("");
    setNotice("正在生成卡片...");
    try {
      const saved = await saveDetail({ refresh: false, silent: true });
      if (!saved) return;
      const result = await api.createKnowledgeGardenDraft(
        { capture_ids: [detail.id] },
        { operationId: operation.operationId },
      );
      if (isAiCancelledResult(result)) {
        setNotice("已停止。知识卡片未生成。");
        return;
      }
      if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
        throw new Error(gardenDraftError(result));
      }
      await refreshAll();
      await loadDetail(detail);
      setNotice(gardenDraftNotice(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCardGenerating(false);
      operation.finish();
    }
  }, [beginAiOperation, detail, loadDetail, refreshAll, saveDetail]);

  const saveEditableCaptureDraftSnapshot = useCallback(async (
    options: { folderPath?: string; silent?: boolean } = {},
  ): Promise<KnowledgeCaptureDraft | null> => {
    const content = editableContent.trim();
    if (!content) return null;
    const draftFolderPath = options.folderPath ?? editableFolder;
    setEditableStatus("saving_draft");
    setEditableProgressMessage("正在保存当前修改...");
    setEditableError("");
    setError("");
    if (!options.silent) setNotice("");
    try {
      const result = editableDraft?.id
          ? await api.updateKnowledgeEditableCaptureDraft(editableDraft.id, {
            content,
            title: editableTitle,
            title_source: editableTitleSource,
            summary: editableSummary,
            tags: parseTagsText(editableTagsText),
            folder_path: draftFolderPath,
            folder_suggestion: {
              mode: editableFolderSuggestionMode,
              folder_path: draftFolderPath,
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
            folder_path: draftFolderPath,
            organize: false,
            existing_folders: visibleFolderPaths,
          });
      const draftId = bridgeMetaString(result, "draft_id") || editableDraft?.id || "";
      if (!draftId) throw new Error("没有返回草稿编号。");
      const payload = await api.getKnowledgeCaptureDraft(draftId);
      applyEditableDraftSuggestion(payload.draft, {
        fallbackContent: content,
        fallbackFolder: draftFolderPath,
      });
      setSelectedKey(`capture_draft:${draftId}`);
      setEditableStatus("ready_to_commit");
      setEditableProgressMessage("已保存当前修改");
      await refreshAll();
      if (!options.silent) setNotice("已保存草稿。");
      return payload.draft;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEditableError(message);
      setEditableStatus("error");
      setEditableProgressMessage("");
      return null;
    }
  }, [
    editableContent,
    editableDraft,
    applyEditableDraftSuggestion,
    editableCardReason,
    editableCardSuggestionsText,
    editableFolderSuggestionMode,
    editableFolderSuggestionReason,
    editableFolder,
    editableGenerateCard,
    editableSummary,
    editableSource,
    editableTagsText,
    editableTitle,
    editableTitleSource,
    refreshAll,
    visibleFolderPaths,
  ]);

  const organizeEditableCaptureDraft = useCallback(async (
    options: { folderPath?: string } = {},
  ): Promise<KnowledgeCaptureDraft | null> => {
    const content = editableContent.trim();
    if (!content) return null;
    const operation = beginAiOperation("library-editable-organize");
    const draftFolderPath = options.folderPath ?? editableFolder;
    setEditableStatus("organizing");
    setEditableCardCommitStatus("idle");
    setEditableProgressMessage("正在生成 AI 建议...");
    setEditableError("");
    setError("");
    setNotice("");
    try {
      const result = editableDraft?.id
          ? await api.updateKnowledgeEditableCaptureDraft(editableDraft.id, {
            content,
            title: editableTitle,
            title_source: editableTitleSource,
            folder_path: draftFolderPath,
            organize: true,
            existing_folders: visibleFolderPaths,
          }, { operationId: operation.operationId, signal: operation.signal })
        : await api.createKnowledgeEditableCaptureDraft({
            content,
            source: editableSource,
            source_type: "manual",
            title: editableTitle,
            title_source: editableTitleSource,
            folder_path: draftFolderPath,
            organize: true,
            existing_folders: visibleFolderPaths,
          }, { operationId: operation.operationId, signal: operation.signal });
      if (operation.isCancelled() || isAiCancelledResult(result)) {
        setEditableStatus("editing");
        setEditableProgressMessage("已停止，正文未被 AI 建议覆盖");
        setNotice("已停止。你可以继续编辑或重新生成 AI 建议。");
        return null;
      }
      const draftId = bridgeMetaString(result, "draft_id") || editableDraft?.id || "";
      if (!draftId) throw new Error("没有返回草稿编号。");
      const payload = await api.getKnowledgeCaptureDraft(draftId);
      if (operation.isCancelled()) return null;
      applyEditableDraftSuggestion(payload.draft, {
        fallbackContent: content,
        fallbackFolder: draftFolderPath,
      });
      setSelectedKey(`capture_draft:${draftId}`);
      if (editableAiSuggestionsStatus(payload.draft) === "failed") {
        setEditableStatus("editing");
        setEditableProgressMessage("AI 建议生成失败，可手动填写或重试");
        await refreshAll();
        setNotice("AI 建议生成失败，正文已保存为草稿。");
        return payload.draft;
      }
      setEditableStatus("ready_to_commit");
      setEditableProgressMessage("整理完成，可以入库");
      await refreshAll();
      setNotice("已生成 AI 建议，可以继续编辑或入库。");
      return payload.draft;
    } catch (err) {
      if (operation.isCancelled() || isAbortError(err)) {
        setEditableStatus("editing");
        setEditableProgressMessage("已请求停止，可继续编辑或重试");
        setNotice("已请求停止。你可以继续编辑或重新生成 AI 建议。");
        return null;
      }
      const message = err instanceof Error ? err.message : String(err);
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
    refreshAll,
    visibleFolderPaths,
  ]);

  const ensureEditableFolder = useCallback(async (folderPath: string) => {
    const target = folderPath.trim() || "Inbox";
    if (!target || target === "Inbox") return target;
    if (folders.some((folder) => folder.path === target)) return target;
    const payload = await api.createKnowledgeLibraryFolder(target);
    await loadFolders();
    return payload.folder.path || target;
  }, [folders, loadFolders]);

  const deleteEditableCaptureDraft = useCallback(async () => {
    if (!editableDraft?.id) return;
    const confirmed = window.confirm(`确定删除草稿《${editableTitle || editableDraft.title || "未命名草稿"}》吗？`);
    if (!confirmed) return;
    setDeleting(true);
    setEditableError("");
    setError("");
    setNotice("");
    try {
      await api.deleteKnowledgeCaptureDraft(editableDraft.id);
      setEditableDraft(null);
      setEditableContent("");
      setEditableTitle("");
      setEditableTitleSource("ai");
      setEditableSummary("");
      setEditableTagsText("");
      setEditableSource("");
      setEditableFolder(selectedFolder || "Inbox");
      setEditableFolderSuggestionMode("existing");
      setEditableFolderSuggestionReason("");
      setEditableGenerateCard(false);
      setEditableCardCommitStatus("idle");
      setEditableCardReason("");
      setEditableCardSuggestionsText("");
      setEditableStatus("empty");
      setEditableProgressMessage("");
      setSelectedKey("");
      await refreshAll();
      setNotice("已删除草稿。");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEditableError(message);
      setEditableStatus("error");
    } finally {
      setDeleting(false);
    }
  }, [editableDraft, editableTitle, refreshAll, selectedFolder]);

  const commitEditableCaptureDraft = useCallback(async () => {
    const operation = beginAiOperation("library-editable-commit");
    setEditableStatus("committing");
    setEditableCardCommitStatus("idle");
    setEditableProgressMessage("正在保存当前修改...");
    setEditableError("");
    setError("");
    setNotice("");
    try {
      const targetFolder = await ensureEditableFolder(editableFolder);
      if (operation.isCancelled()) return;
      if (targetFolder !== editableFolder) {
        setEditableFolder(targetFolder);
      }
      const draft = await saveEditableCaptureDraftSnapshot({
        folderPath: targetFolder,
        silent: true,
      });
      if (operation.isCancelled()) return;
      if (!draft) return;
      setEditableStatus("committing");
      setEditableProgressMessage("正在写入知识库文件...");
      const commitResult = await api.commitKnowledgeCaptureDraft(draft.id, {
        operationId: operation.operationId,
        signal: operation.signal,
      });
      if (operation.isCancelled() || isAiCancelledResult(commitResult)) {
        setEditableStatus("ready_to_commit");
        setEditableProgressMessage("已停止，草稿仍保留");
        setNotice("已停止。草稿仍保留，可继续编辑或重试入库。");
        return;
      }
      setEditableProgressMessage("正在重建索引和大纲...");
      const payload = await api.getKnowledgeCaptureDraft(draft.id);
      if (operation.isCancelled()) return;
      applyEditableDraftSuggestion(payload.draft, {
        fallbackContent: "",
        fallbackFolder: targetFolder,
      });
      setSelection({ type: "folder", value: targetFolder || "Inbox" });
      setExpandedFolders((current) => new Set(current).add(targetFolder || "Inbox"));
      setSelectedKey(`capture_draft:${draft.id}`);
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
      setEditableProgressMessage("入库完成");
      await refreshAll();
      if (cardResult.generated) {
        setNotice(`已入库并生成知识卡片：《${payload.draft.title || "未命名草稿"}》。`);
      } else if (cardResult.error) {
        setNotice(`已入库，但知识卡片生成失败：${cardResult.error}`);
      } else {
        setNotice(`已入库到知识库：《${payload.draft.title || "未命名草稿"}》。`);
      }
    } catch (err) {
      if (operation.isCancelled() || isAbortError(err)) {
        setEditableStatus("ready_to_commit");
        setEditableProgressMessage("已请求停止，可继续编辑或重试");
        setNotice("已请求停止。草稿仍保留，可继续编辑或重试入库。");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setEditableError(message);
      setEditableStatus("error");
      setEditableProgressMessage("");
    } finally {
      operation.finish();
    }
  }, [
    editableCardReason,
    editableCardSuggestionsText,
    editableFolder,
    editableGenerateCard,
    ensureEditableFolder,
    applyEditableDraftSuggestion,
    beginAiOperation,
    maybeGenerateGardenCardAfterCommit,
    refreshAll,
    saveEditableCaptureDraftSnapshot,
  ]);

  const markArticleAiStopped = useCallback((assistantId: string, message = "已停止生成。") => {
    setChatMessagesByMode((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as Array<keyof ArticleChatMessagesByMode>) {
        next[key] = next[key].map((item) =>
          item.id === assistantId && item.role === "assistant" && item.pending
            ? {
                ...item,
                content: item.content && !item.content.startsWith("正在") ? item.content : message,
                pending: false,
                warnings: uniqueStrings([...(item.warnings || []), message]),
              }
            : item,
        );
      }
      return next;
    });
  }, []);

  const stopArticleAi = useCallback(() => {
    const streamController = chatStreamAbortRef.current;
    const assistantId = chatStreamAssistantIdRef.current;
    if (!streamController) return;
    streamController.abort();
    chatStreamAbortRef.current = null;
    chatStreamAssistantIdRef.current = "";
    setChatLoading(false);
    setChatError("");
    if (assistantId) {
      markArticleAiStopped(assistantId);
    }
  }, [markArticleAiStopped]);

  const applyHistorySummaryUpdate = useCallback((summary: string | undefined, version: number | undefined) => {
    const nextSummary = (summary || "").trim();
    const nextVersion = Number(version || 0);
    if (!nextSummary || !Number.isFinite(nextVersion)) return;
    setHistorySummaryVersion((currentVersion) => {
      if (nextVersion <= currentVersion) return currentVersion;
      setHistorySummary(nextSummary);
      setChatMessagesByMode((current) => markCompressedHistoryMessages(current, nextVersion));
      return nextVersion;
    });
  }, []);

  const askArticleAi = useCallback(async (override?: { question?: string; mode?: KnowledgeResearchMode; requestContext?: ArticleAiRequestContext }) => {
    if (!detail || chatLoading) return;
    const requestContext = override?.requestContext;
    const question = (requestContext?.question ?? override?.question ?? chatQuestion).trim();
    const requestMode = requestContext?.mode ?? override?.mode ?? articleResearchMode;
    if (!question) return;
    const context = selectionContext;
    const modeMessages = chatMessagesByMode[articleChatModeKey(requestMode)] || [];
    const requestBody: ArticleAiRequestContext = requestContext || {
      question,
      selected_text: context?.selectedText || "",
      surrounding_before: context?.surroundingBefore || "",
      surrounding_after: context?.surroundingAfter || "",
      heading_path: context?.headingPath || [],
      selection_start: context?.selectionStart,
      selection_end: context?.selectionEnd,
      selection_confidence: context?.selectionConfidence || "none",
      mode: requestMode,
      history: selectionChatHistory(modeMessages),
      history_summary: historySummary,
      history_summary_version: historySummaryVersion,
      history_overflow: selectionChatHistoryOverflow(chatMessagesByMode),
      force_web: requestMode === "local_web" || requestMode === "web_only",
    };
    requestBody.history = selectionChatHistory(modeMessages);
    requestBody.history_summary = historySummary;
    requestBody.history_summary_version = historySummaryVersion;
    requestBody.history_overflow = selectionChatHistoryOverflow(chatMessagesByMode);
    requestBody.force_web = requestBody.mode === "local_web" || requestBody.mode === "web_only";
    if ((requestBody.selected_text || "").trim().length > MAX_SELECTION_SEARCH_CHARS) {
      setChatError(SELECTION_TOO_LONG_MESSAGE);
      return;
    }
    const assistantId = `assistant-${Date.now()}`;
    const pendingTrace = pendingResearchTrace(question, requestMode, Boolean(requestBody.force_web));
    const userMessage: ArticleChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question,
      selectionPreview: requestBody.selected_text ? requestBody.selected_text.slice(0, 160) : "",
      createdAt: new Date().toISOString(),
      requestContext: requestBody,
    };
    const pendingMessage: ArticleChatMessage = {
      id: assistantId,
      role: "assistant",
      content: requestMode === "local_web" ? "正在基于可用材料回答..." : "正在基于当前文章回答...",
      selectionPreview: requestBody.selected_text ? requestBody.selected_text.slice(0, 160) : "",
      createdAt: new Date().toISOString(),
      pending: true,
      mode: requestMode,
      requestContext: requestBody,
      researchTrace: pendingTrace,
      responseMeta: {
        web_queries: [],
        research_trace: pendingTrace,
        web_search_attempted: Boolean(requestBody.force_web),
      },
    };
    setChatMessagesForMode(requestMode, (messages) => [...messages, userMessage, pendingMessage]);
    setChatQuestion("");
    setSelectionContext(null);
    window.getSelection()?.removeAllRanges();
    setChatLoading(true);
    setChatError("");
    let sawProgressEvent = false;
    let answerDeltaBuffer = "";
    let answerDeltaFlushTimer: ReturnType<typeof window.setTimeout> | null = null;
    const flushAnswerDeltas = () => {
      if (answerDeltaFlushTimer) {
        window.clearTimeout(answerDeltaFlushTimer);
        answerDeltaFlushTimer = null;
      }
      if (!answerDeltaBuffer) return;
      const delta = answerDeltaBuffer;
      answerDeltaBuffer = "";
      const mergedEvent: KnowledgeLibrarySelectionChatStreamEvent = {
        event: "progress",
        type: "answer_delta",
        delta,
      };
      setChatMessagesForMode(requestMode, (messages) =>
        messages.map((message) =>
          message.id === assistantId ? applySelectionChatStreamEvent(message, mergedEvent, requestMode) : message,
        ),
      );
    };
    const scheduleAnswerDeltaFlush = () => {
      if (answerDeltaFlushTimer) return;
      answerDeltaFlushTimer = window.setTimeout(flushAnswerDeltas, 80);
    };
    const streamController = new AbortController();
    let streamTimedOut = false;
    const streamTimeoutTimer = window.setTimeout(() => {
      streamTimedOut = true;
      streamController.abort();
    }, ARTICLE_AI_STREAM_TIMEOUT_MS);
    chatStreamAbortRef.current = streamController;
    chatStreamAssistantIdRef.current = assistantId;
    try {
      const response = await api.streamSelectionChatKnowledgeLibraryItem(
        detail.kind,
        detail.id,
        requestBody,
        (event) => {
          if (event.event === "progress") {
            sawProgressEvent = true;
          }
          if (event.event === "summary_updated") {
            applyHistorySummaryUpdate(event.updated_history_summary, event.updated_history_summary_version);
            return;
          }
          if (event.event === "progress" && event.type === "answer_delta") {
            answerDeltaBuffer += event.delta || "";
            scheduleAnswerDeltaFlush();
            return;
          }
          flushAnswerDeltas();
          setChatMessagesForMode(requestMode, (messages) =>
            messages.map((message) =>
              message.id === assistantId ? applySelectionChatStreamEvent(message, event, requestMode) : message,
            ),
          );
        },
        streamController.signal,
      );
      flushAnswerDeltas();
      const assistantMessage: ArticleChatMessage = {
        id: assistantId,
        role: "assistant",
        content: response.answer || "AI 没有返回内容。",
        selectionPreview: response.used_selection && requestBody.selected_text ? requestBody.selected_text.slice(0, 160) : "",
        createdAt: new Date().toISOString(),
        mode: response.mode || requestMode,
        requestContext: requestBody,
        sources: response.sources,
        researchTrace: response.meta?.research_trace,
        responseMeta: response.meta,
        warnings: response.warnings,
      };
      applyHistorySummaryUpdate(response.meta?.updated_history_summary, response.meta?.updated_history_summary_version);
      setChatMessagesForMode(requestMode, (messages) =>
        messages.map((message) =>
          message.id === assistantId ? assistantMessage : message,
        ),
      );
    } catch (err) {
      if (streamController.signal.aborted) {
        const stoppedMessage = streamTimedOut ? "生成超时，已停止。" : "已停止生成。";
        if (streamTimedOut) {
          setChatError(stoppedMessage);
        }
        markArticleAiStopped(assistantId, stoppedMessage);
        return;
      }
      try {
        const response = sawProgressEvent
          ? null
          : await api.selectionChatKnowledgeLibraryItem(detail.kind, detail.id, requestBody);
        if (!response) {
          throw err;
        }
        const assistantMessage: ArticleChatMessage = {
          id: assistantId,
          role: "assistant",
          content: response.answer || "AI 没有返回内容。",
          selectionPreview: response.used_selection && requestBody.selected_text ? requestBody.selected_text.slice(0, 160) : "",
          createdAt: new Date().toISOString(),
          mode: response.mode || requestMode,
          requestContext: requestBody,
          sources: response.sources,
          researchTrace: response.meta?.research_trace,
          responseMeta: response.meta,
          warnings: [...(response.warnings || []), "实时流式连接失败，已回退到普通请求。"],
        };
        applyHistorySummaryUpdate(response.meta?.updated_history_summary, response.meta?.updated_history_summary_version);
        setChatMessagesForMode(requestMode, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? assistantMessage : message,
          ),
        );
      } catch (fallbackErr) {
        const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        setChatError(message);
        setChatMessagesForMode(requestMode, (messages) =>
          messages.map((item) =>
            item.id === assistantId
              ? {
                  ...item,
                  content: `AI 问答失败：${message}`,
                  pending: false,
                  warnings: uniqueStrings([...(item.warnings || []), message]),
                }
              : item,
          ),
        );
      }
    } finally {
      window.clearTimeout(streamTimeoutTimer);
      flushAnswerDeltas();
      if (chatStreamAbortRef.current === streamController) {
        chatStreamAbortRef.current = null;
        if (chatStreamAssistantIdRef.current === assistantId) {
          chatStreamAssistantIdRef.current = "";
        }
        setChatLoading(false);
      }
    }
  }, [applyHistorySummaryUpdate, articleResearchMode, chatLoading, chatMessagesByMode, chatQuestion, detail, historySummary, historySummaryVersion, markArticleAiStopped, selectionContext, setChatMessagesForMode]);

  const rerunArticleAi = useCallback((message: ArticleChatMessage, mode: KnowledgeResearchMode, forceWeb = false) => {
    const baseContext = message.requestContext;
    if (!baseContext?.question.trim()) return;
    void askArticleAi({
      requestContext: {
        ...baseContext,
        mode,
        force_web: forceWeb,
      },
    });
  }, [askArticleAi]);

  const saveArticleAiAnswer = useCallback(async (
    message: ArticleChatMessage,
    outputType: "local_learning_note" | "knowledge_card",
  ) => {
    if (!detail || message.role !== "assistant") return;
    setSavingArticleAnswerId(message.id);
    setChatError("");
    try {
      const result = await api.createKnowledgeAnswerDraft({
        hermes_session_id: "knowledge-library",
        user_message: [...chatMessages].reverse().find((item) => item.role === "user")?.content || chatQuestion || detail.title,
        assistant_answer: message.content,
        instruction: outputType === "knowledge_card" ? "把知识库右侧 AI 回答做成卡片" : "把知识库右侧 AI 回答存成资料笔记",
        output_type: outputType,
        assistant_message_id: message.id,
        sources: articleSourcesForSave(message.sources, detail),
        answer_source: "provided",
        folder_path: detail.folder_path || "",
      });
      const draftId =
        typeof result.meta?.reading_draft_id === "string"
          ? result.meta.reading_draft_id
          : "";
      await refreshAll();
      setNotice(result.chat_preview || (outputType === "knowledge_card" ? "已生成知识卡片草稿。" : "已生成资料笔记草稿。"));
      if (draftId) {
        navigate(`/knowledge-chat?answerDraft=${encodeURIComponent(draftId)}`);
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingArticleAnswerId("");
    }
  }, [chatMessages, chatQuestion, detail, navigate, refreshAll]);

  const openKnowledgeSource = useCallback((source: KnowledgeResearchSource) => {
    const rawKind = String(source.item_kind || "").trim();
    const sourceType = String(source.type || "").trim().toLowerCase();
    const openUrl = String(source.open_url || "").trim();
    const cardUrl = openUrl.startsWith("/cards-board/") ? openUrl : "";
    const isCard = cardUrl !== "" || rawKind === "garden_card" || rawKind === "knowledge_card"
      || sourceType === "garden_card" || sourceType === "knowledge_card";
    if (isCard) {
      const cardId = String(source.item_id || source.id || "").trim();
      if (!cardId && !cardUrl) {
        setNotice("这个知识卡片来源暂时缺少可打开的卡片信息。");
        return;
      }
      if (!confirmLeaveCurrentWork()) return;
      navigate(cardUrl || `/cards-board/${encodeURIComponent(cardId)}`);
      return;
    }
    const kind = rawKind === "capture_draft" ? "capture_draft" : rawKind === "capture" ? "capture" : "";
    const itemId = String(source.item_id || "").trim();
    if (!kind || !itemId) {
      setNotice("这个知识库来源暂时缺少可打开的本地文件信息。");
      return;
    }
    if (!confirmLeaveCurrentWork()) return;
    const existing = allItems.find((item) => item.kind === kind && item.id === itemId) || null;
    const folder = existing?.folder_path || "Inbox";
    if (existing?.folder_path) {
      setSelection({ type: "folder", value: folder });
      setExpandedFolders((current) => new Set(current).add(folder));
    } else {
      setSelection(DEFAULT_SELECTION);
    }
    setStatusFilter("all");
    setSelectedKey(`${kind}:${itemId}`);
    setWorkbenchMode("browse");
    switchMode("files");
    void loadDetail((existing || {
      id: itemId,
      kind,
      title: source.title || itemId,
      folder_path: folder,
    }) as KnowledgeLibraryItem);
  }, [allItems, confirmLeaveCurrentWork, loadDetail, navigate, switchMode]);

  const openKnowledgeSourceLocal = useCallback(async (source: KnowledgeResearchSource) => {
    const itemId = String(source.item_id || "").trim();
    if (source.item_kind !== "capture" || !itemId) {
      setNotice("这个知识库来源暂时缺少可打开的本地文件信息。");
      return;
    }
    setError("");
    setNotice("");
    try {
      const result = await api.openKnowledgeLibraryItemLocal("capture", itemId);
      setNotice(`已用本地默认 App 打开：${result.path}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const canPublishDetail = detail?.kind === "capture_draft" && !committing && !saving && !deleting;
  const canGenerateCard = detail?.kind === "capture" && !cardGenerating && !saving && !deleting;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-foreground">
      {readingFullscreen && detail ? (
        <ImmersiveReadingOverlay
          body={draftBody}
          title={draftTitle || detail.title || "未命名文件"}
          onExit={() => setReadingFullscreen(false)}
        />
      ) : null}
      <KnowledgeLibraryHeader
        detail={detail}
        sidebarCollapsed={sidebarCollapsed}
        leftPaneCollapsed={leftPaneCollapsed}
        aiPanelOpen={aiPanelOpen}
        allSidebarsCollapsed={allSidebarsCollapsed}
        canEnterReadingFullscreen={canEnterReadingFullscreen}
        viewMenuOpen={viewMenuOpen}
        newMenuOpen={newMenuOpen}
        importInputRef={importInputRef}
        onToggleViewMenu={() => {
          setViewMenuOpen((open) => !open);
          setNewMenuOpen(false);
        }}
        onToggleNewMenu={() => {
          setNewMenuOpen((open) => !open);
          setViewMenuOpen(false);
        }}
        onToggleWorkspaceNavigation={toggleWorkspaceNavigation}
        onToggleKnowledgeLeftPane={toggleKnowledgeLeftPane}
        onToggleArticleAiPanel={toggleArticleAiPanel}
        onToggleAllSidebars={toggleAllSidebars}
        onEnterReadingFullscreen={enterReadingFullscreen}
        onCreateKnowledgeFile={createKnowledgeFile}
        onImportContent={importContent}
        onHandleImportContent={(event) => void handleImportContent(event)}
      />

      {(error || notice) && (
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm",
            error
              ? "border-destructive/30 bg-destructive/8 text-destructive"
              : "border-primary/20 bg-primary/8 text-foreground",
          )}
        >
          {error ? <CircleAlert className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-primary" />}
          <span className="min-w-0 truncate">{error || notice}</span>
        </div>
      )}

      <div
        ref={libraryLayoutRef}
        style={libraryLayoutStyle}
        className={cn(
          "grid min-h-0 flex-1 gap-0",
          leftPaneCollapsed
            ? "lg:grid-cols-[8px_minmax(0,1fr)]"
            : "lg:grid-cols-[var(--knowledge-left-width)_8px_minmax(0,1fr)]",
        )}
      >
        <KnowledgeLibrarySidebar
          leftPaneCollapsed={leftPaneCollapsed}
          setLeftPaneCollapsed={setLeftPaneCollapsed}
          refreshAll={refreshAll}
          loadingFolders={loadingFolders}
          loadingItems={loadingItems}
          stats={stats}
          query={query}
          setQuery={setQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          visibleItems={visibleItems}
          selectionTitle={selectionTitle}
          selectedKey={selectedKey}
          openItemFromSidebar={openItemFromSidebar}
          createKnowledgeFile={createKnowledgeFile}
          importContent={importContent}
          selection={selection}
          selectAllFiles={selectAllFiles}
          selectView={selectView}
          views={views}
          allItemsCount={allItems.length}
          folders={folders}
          newFolderName={newFolderName}
          setNewFolderName={setNewFolderName}
          createFolder={createFolder}
          creatingFolder={creatingFolder}
          expandedFolders={expandedFolders}
          toggleFolder={toggleFolder}
          selectFolder={selectFolder}
          startRenameFolder={startRenameFolder}
          cancelRenameFolder={cancelRenameFolder}
          renamingFolder={renamingFolder}
          renameFolderName={renameFolderName}
          setRenameFolderName={setRenameFolderName}
          folderRenaming={folderRenaming}
          renameFolder={renameFolder}
          itemsByFolder={itemsByFolder}
          libraryLayoutRef={libraryLayoutRef}
          setLeftPaneWidth={setLeftPaneWidth}
        />

	        {mode === "paste" ? (
	          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
	            <EditableCaptureWorkbench
              content={editableContent}
              draft={editableDraft}
              error={editableError}
              cardReason={editableCardReason}
              cardSuggestionsText={editableCardSuggestionsText}
              folderSuggestionMode={editableFolderSuggestionMode}
              folderSuggestionReason={editableFolderSuggestionReason}
              folderOptions={folderOptions}
              folderPath={editableFolder}
              cardCommitStatus={editableCardCommitStatus}
              generateCard={editableGenerateCard}
              progressMessage={editableProgressMessage}
              source={editableSource}
              status={editableStatus}
              summary={editableSummary}
              tagsText={editableTagsText}
              title={editableTitle}
              onCommit={() => void commitEditableCaptureDraft()}
              onCardReasonChange={setEditableCardReason}
              onCardSuggestionsTextChange={setEditableCardSuggestionsText}
              onContentChange={(value) => {
                setEditableContent(value);
                if (editableStatus !== "committed") {
                  setEditableStatus(value.trim() ? "editing" : "empty");
                  setEditableProgressMessage("");
                  setEditableCardCommitStatus("idle");
                }
              }}
              onFolderChange={(value) => {
                setEditableFolder(value);
                if (editableStatus !== "committed") {
                  setEditableStatus("editing");
                  setEditableProgressMessage("");
                }
              }}
              onFolderSuggestionModeChange={setEditableFolderSuggestionMode}
              onFolderSuggestionReasonChange={setEditableFolderSuggestionReason}
              onGenerateCardChange={setEditableGenerateCard}
              onDeleteDraft={() => void deleteEditableCaptureDraft()}
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
	          </section>
	        ) : (
	          <div
                ref={articleLayoutRef}
                style={articleLayoutStyle}
	            className={cn(
	              "grid min-h-0 gap-0",
	              detail && workbenchMode === "browse" && aiPanelMode === "collapsed" && !allSidebarsCollapsed
	                ? "xl:grid-cols-[minmax(0,1fr)_8px]"
	                : detail && workbenchMode === "browse" && aiPanelOpen && !allSidebarsCollapsed
	                  ? "xl:grid-cols-[minmax(0,1fr)_8px_var(--knowledge-ai-width)]"
	                  : "xl:grid-cols-[minmax(0,1fr)]",
	            )}
	          >
	            <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
	              {loadingDetail ? (
	                <LoadingState text="读取文件详情..." />
	              ) : detail ? (
	                <FileWorkbench
	                  body={draftBody}
	                  canGenerateCard={canGenerateCard}
	                  committing={committing}
	                  cardGenerating={cardGenerating}
	                  deleting={deleting}
	                  detail={detail}
	                  folder={draftFolder}
	                  folders={folders}
	                  mode={workbenchMode}
	                  saving={saving}
	                  title={draftTitle}
	                  canPublish={canPublishDetail}
	                  onAiPanelToggle={() => setAiPanelMode((current) => current === "collapsed" ? "assist" : "collapsed")}
	                  onBodyChange={setDraftBody}
	                  onDelete={() => void deleteDetail()}
	                  onFolderChange={setDraftFolder}
	                  onGenerateCard={() => void generateCard()}
	                  onOpenLocal={() => void openDetailLocal()}
	                  onPermanentDelete={() => void deleteDetailPermanent()}
	                  onModeChange={setWorkbenchMode}
	                  onPublish={() => void commitDraft()}
	                  onSave={() => void saveDetail()}
	                  onStopAiOperation={stopAiOperation}
	                  stoppingAiOperation={Boolean(aiOperation?.stopping)}
	                  onSelectionContextChange={setSelectionContext}
	                  onTitleChange={setDraftTitle}
	                  aiPanelOpen={aiPanelOpen}
	                />
	              ) : (
	                <EmptyState text="从左栏选择一份资料或专题开始伴读。选中正文里的任意一段，右侧 AI 会结合上下文为你解惑，并可一键提炼成知识卡片。" />
	              )}
	            </section>
	            {detail && workbenchMode === "browse" && aiPanelOpen && !allSidebarsCollapsed ? (
                  <>
                    <ResizableRail
                      containerRef={articleLayoutRef}
                      defaultWidth={aiPanelMode === "focus" ? DEFAULT_KNOWLEDGE_AI_FOCUS_WIDTH : DEFAULT_KNOWLEDGE_AI_WIDTH}
                      edge="left"
                      maxWidth={aiPanelMode === "focus" ? 720 : 560}
                      minWidth={320}
                      onCommit={aiPanelMode === "focus" ? setAiFocusPaneWidth : setAiPaneWidth}
                      storageKey={aiPanelMode === "focus" ? KNOWLEDGE_AI_FOCUS_WIDTH_KEY : KNOWLEDGE_AI_WIDTH_KEY}
                      variableName="--knowledge-ai-width"
                    />
                    <ArticleAIPanel
                      chatError={chatError}
                      detail={detail}
                      loading={chatLoading}
                      messages={chatMessages}
                      researchMode={articleResearchMode}
                      question={chatQuestion}
                      savingAnswerId={savingArticleAnswerId}
                      onAsk={() => void askArticleAi()}
                      onAskPrompt={(prompt) => void askArticleAi({ question: prompt })}
                      onClose={() => setAiPanelMode("collapsed")}
                      onQuestionChange={setChatQuestion}
                      onResearchModeChange={setArticleResearchMode}
                      onRerun={rerunArticleAi}
                      onOpenSource={openKnowledgeSource}
                      onOpenSourceLocal={openKnowledgeSourceLocal}
                      onSaveAnswer={saveArticleAiAnswer}
                      onStop={stopArticleAi}
                    />
                  </>
	            ) : detail && workbenchMode === "browse" && aiPanelMode === "collapsed" && !allSidebarsCollapsed ? (
                  <CollapsedAIPanelRail
                    loading={chatLoading}
                    onOpen={() => setAiPanelMode("assist")}
                  />
	            ) : null}
	          </div>
	        )}
	      </div>
	    </div>
	  );
	}

interface KnowledgeLibrarySidebarProps {
  leftPaneCollapsed: boolean;
  setLeftPaneCollapsed: (value: boolean) => void;
  refreshAll: () => void | Promise<void>;
  loadingFolders: boolean;
  loadingItems: boolean;
  stats: { all: number; drafts: number; inLibrary: number; cards: number };
  query: string;
  setQuery: (value: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (value: StatusFilter) => void;
  visibleItems: KnowledgeLibraryItem[];
  selectionTitle: string;
  selectedKey: string;
  openItemFromSidebar: (item: KnowledgeLibraryItem) => void;
  createKnowledgeFile: () => void;
  importContent: () => void;
  selection: LibrarySelection;
  selectAllFiles: () => void;
  selectView: (view: string, filter?: StatusFilter) => void;
  views: KnowledgeLibrarySmartView[];
  allItemsCount: number;
  folders: KnowledgeLibraryFolder[];
  newFolderName: string;
  setNewFolderName: (value: string) => void;
  createFolder: () => void | Promise<void>;
  creatingFolder: boolean;
  expandedFolders: Set<string>;
  toggleFolder: (folder: string) => void;
  selectFolder: (folder: string) => void;
  startRenameFolder: (folder: KnowledgeLibraryFolder) => void;
  cancelRenameFolder: () => void;
  renamingFolder: string;
  renameFolderName: string;
  setRenameFolderName: (value: string) => void;
  folderRenaming: boolean;
  renameFolder: () => void | Promise<void>;
  itemsByFolder: Map<string, KnowledgeLibraryItem[]>;
  libraryLayoutRef: React.RefObject<HTMLDivElement | null>;
  setLeftPaneWidth: (width: number) => void;
}

function KnowledgeLibrarySidebar({
  leftPaneCollapsed,
  setLeftPaneCollapsed,
  refreshAll,
  loadingFolders,
  loadingItems,
  stats,
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  visibleItems,
  selectionTitle,
  selectedKey,
  openItemFromSidebar,
  createKnowledgeFile,
  importContent,
  selection,
  selectAllFiles,
  selectView,
  views,
  allItemsCount,
  folders,
  newFolderName,
  setNewFolderName,
  createFolder,
  creatingFolder,
  expandedFolders,
  toggleFolder,
  selectFolder,
  startRenameFolder,
  cancelRenameFolder,
  renamingFolder,
  renameFolderName,
  setRenameFolderName,
  folderRenaming,
  renameFolder,
  itemsByFolder,
  libraryLayoutRef,
  setLeftPaneWidth,
}: KnowledgeLibrarySidebarProps) {
  if (leftPaneCollapsed) {
    return <CollapsedKnowledgeLeftRail onExpand={() => setLeftPaneCollapsed(false)} />;
  }
  return (
    <>
            <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
              <div className="shrink-0 border-b border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">资料与专题</h2>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setLeftPaneCollapsed(true)}
                      className="rounded p-1 text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
                      title="收起侧栏"
                      aria-label="收起侧栏"
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void refreshAll()}
                      className="rounded p-1 text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
                      title="刷新"
                      aria-label="刷新"
                    >
                      <RefreshCw className={cn("h-4 w-4", (loadingFolders || loadingItems) && "animate-spin")} />
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <Metric label="全部" value={stats.all} />
                  <Metric label="草稿" value={stats.drafts} />
                  <Metric label="已入库" value={stats.inLibrary} />
                  <Metric label="有卡片" value={stats.cards} />
                </div>
                <label className="mt-3 flex h-9 items-center gap-2 rounded-md border border-border bg-background/70 px-3">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索文件"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </label>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {STATUS_FILTERS.map((filter) => (
                    <FilterButton
                      key={filter.key}
                      active={statusFilter === filter.key}
                      label={filter.label}
                      onClick={() => setStatusFilter(filter.key)}
                    />
                  ))}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {query.trim() || statusFilter !== "all" ? (
              <div>
                <div className="mb-2 flex items-start justify-between gap-3 px-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-[0.68rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      {query.trim() ? "搜索结果" : selectionTitle}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {visibleItems.length} 个文件
                    </p>
                  </div>
                </div>
                {loadingItems ? (
                  <LoadingState text="读取文件..." />
                ) : visibleItems.length ? (
                  <div className="space-y-1.5">
                    {visibleItems.map((item) => (
                      <FileListItem
                        key={itemKey(item)}
                        active={selectedKey === itemKey(item)}
	                        item={item}
	                        onClick={() => openItemFromSidebar(item)}
	                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    text="当前知识库范围没有文件。"
                    onCreate={createKnowledgeFile}
                    onImport={importContent}
                  />
                )}
              </div>
            ) : (
              <>
                <NavSection title="处理队列">
                  <SidebarButton
                    active={selection.type === "all"}
                    count={stats.all}
                    icon={Layers3}
                    label="所有文件"
                    onClick={selectAllFiles}
                  />
                  <SidebarButton
                    active={selection.type === "view" && selection.value === "review"}
                    count={stats.drafts}
                    icon={Archive}
                    label="草稿箱"
                    onClick={() => selectView("review", "draft")}
                  />
                  <SidebarButton
                    active={selection.type === "view" && selection.value === "recent"}
                    count={viewCount(views, "recent", allItemsCount)}
                    icon={Clock3}
                    label="最近更新"
                    onClick={() => selectView("recent")}
                  />
                </NavSection>

                <NavSection title="文件夹">
                  <div className="mb-2 flex gap-2 px-1">
                    <input
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void createFolder();
                      }}
                      placeholder="新建文件夹"
                      className="min-w-0 flex-1 rounded-md border border-border bg-background/70 px-2 py-1.5 text-sm outline-none focus:border-primary/40"
                    />
                    <button
                      type="button"
                      onClick={() => void createFolder()}
                      disabled={creatingFolder || !newFolderName.trim()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-40"
                    >
                      {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
                      创建
                    </button>
                  </div>
                  {folders.map((folder) => (
                    <FolderNode
                      key={folder.path}
                      active={selection.type === "folder" && selection.value === folder.path}
                      expanded={expandedFolders.has(folder.path)}
                      folder={folder}
                      editing={renamingFolder === folder.path}
                      editValue={renameFolderName}
                      renaming={folderRenaming && renamingFolder === folder.path}
                      items={itemsByFolder.get(folder.path) ?? []}
                      selectedKey={selectedKey}
                      onCancelRename={cancelRenameFolder}
                      onEditValueChange={setRenameFolderName}
                      onOpenItem={openItemFromSidebar}
                      onRename={() => void renameFolder()}
                      onSelectFolder={selectFolder}
                      onStartRename={startRenameFolder}
                      onToggleFolder={toggleFolder}
                    />
                  ))}
                </NavSection>
              </>
            )}
              </div>
            </aside>
            <ResizableRail
              containerRef={libraryLayoutRef}
              defaultWidth={DEFAULT_KNOWLEDGE_LEFT_WIDTH}
              maxWidth={460}
              minWidth={260}
              onCommit={setLeftPaneWidth}
              storageKey={KNOWLEDGE_LEFT_WIDTH_KEY}
              variableName="--knowledge-left-width"
            />
    </>
  );
}
function itemKey(item: KnowledgeLibraryItem): string {
  return `${item.kind}:${item.id}`;
}

function formatIso(value: string): string {
  if (!value) return "未知时间";
  return isoTimeAgo(value);
}

function bridgeMetaString(result: Record<string, unknown>, key: string): string {
  const direct = result[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const meta = result.meta;
  if (meta && typeof meta === "object") {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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
  const folderPath = stringValue(suggestion.folder_path) || stringValue(intent?.folder_path) || "Inbox";
  return {
    mode,
    folder_path: folderPath,
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

function articleSourcesForSave(
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

function gardenDraftNotice(result: KnowledgeGardenDraftResponse): string {
  const title = result.meta?.title;
  if (typeof title === "string" && title.trim()) {
    return `已生成知识卡片：《${title.trim()}》。`;
  }
  const previewLine = (result.chat_preview || result.USER_VISIBLE_REPLY || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return previewLine || "已生成知识卡片。";
}

function gardenDraftError(result: KnowledgeGardenDraftResponse): string {
  return result.error || result.errors?.[0] || result.USER_VISIBLE_REPLY || result.chat_preview || "生成知识卡片失败。";
}

function libraryDeleteNotice(result: KnowledgeLibraryDeleteResponse): string {
  const dependencies = result.dependencies;
  if (!dependencies) return result.message || "已归档入库文件。";
  const { cardCount, gardenDraftCount, backlinkCount, draftCount, eventCount } = libraryDependencyCounts(dependencies);
  const parts = [
    cardCount ? `${cardCount} 张卡片` : "",
    gardenDraftCount ? `${gardenDraftCount} 条卡片草稿` : "",
    backlinkCount ? `${backlinkCount} 个引用` : "",
    draftCount ? `${draftCount} 条历史草稿` : "",
    eventCount ? `${eventCount} 条运行记录` : "",
  ].filter(Boolean);
  if (!parts.length) return "已归档入库文件，保留源文件和数据库记录。";
  return `已归档入库文件，保留源文件、数据库记录、${parts.join("、")}。`;
}

function libraryDeleteConfirmMessage(
  item: KnowledgeLibraryItem,
  dependencies?: KnowledgeLibraryDependencies,
): string {
  if (item.kind !== "capture") {
    return `确定删除草稿《${item.title || "未命名草稿"}》吗？`;
  }
  const counts = libraryDependencyCounts(dependencies);
  return [
    `确定从知识库移除《${item.title || "未命名文件"}》吗？`,
    "",
    "这不是物理删除：文件会标记为归档并从知识库列表隐藏。",
    "",
    "将保留：",
    "- 本地正文和来源记录",
    `- Knowledge Card：${counts.cardCount} 张`,
    `- 卡片草稿：${counts.gardenDraftCount} 条`,
    `- 历史草稿：${counts.draftCount} 条`,
    `- 其他文件引用：${counts.backlinkCount} 个`,
    `- 运行记录：${counts.eventCount} 条`,
    "- 数据库 capture 行：保留，状态改为 archived",
  ].join("\n");
}

function libraryHasBlockingDependencies(dependencies?: KnowledgeLibraryDependencies): boolean {
  const counts = libraryDependencyCounts(dependencies);
  return counts.cardCount > 0 ||
    counts.gardenDraftCount > 0 ||
    counts.backlinkCount > 0;
}

function libraryPermanentDeleteBlockedMessage(
  item: KnowledgeLibraryItem,
  dependencies?: KnowledgeLibraryDependencies,
): string {
  const counts = libraryDependencyCounts(dependencies);
  const parts = [
    counts.cardCount ? `${counts.cardCount} 张知识卡片` : "",
    counts.gardenDraftCount ? `${counts.gardenDraftCount} 条卡片草稿` : "",
    counts.backlinkCount ? `${counts.backlinkCount} 个文件引用` : "",
  ].filter(Boolean);
  const reason = parts.length ? parts.join("、") : "其他知识对象";
  return `无法彻底删除《${item.title || "未命名文件"}》：仍被 ${reason} 引用。请先解除引用，或使用“归档”。`;
}

function libraryPermanentDeleteConfirmMessage(
  item: KnowledgeLibraryItem,
  dependencies?: KnowledgeLibraryDependencies,
): string {
  const counts = libraryDependencyCounts(dependencies);
  const traceLines = [
    counts.draftCount ? `- 历史草稿指针：${counts.draftCount} 条，将解绑` : "",
    counts.eventCount ? `- 运行对象索引：${counts.eventCount} 条，将删除` : "",
  ].filter(Boolean);
  return [
    `确定彻底删除《${item.title || "未命名文件"}》吗？`,
    "",
    "这会删除本地 Markdown 正文、raw 来源文件、数据库 capture 行和本地索引记录。",
    "只有在没有活跃知识卡片、待提交卡片草稿和其他文件引用时才允许执行。",
    ...(traceLines.length ? ["", "历史草稿和运行记录不是硬阻断，会同步清理：", ...traceLines] : []),
    "",
    "此操作不可从 Hermes UI 恢复。",
  ].join("\n");
}

function libraryPermanentDeleteNotice(result: { message?: string }): string {
  return result.message || "已彻底删除入库文件。";
}

function libraryDependencyCounts(dependencies?: KnowledgeLibraryDependencies): {
  cardCount: number;
  gardenDraftCount: number;
  draftCount: number;
  backlinkCount: number;
  eventCount: number;
} {
  return {
    cardCount: dependencies?.garden_cards?.length ?? 0,
    gardenDraftCount: dependencies?.garden_drafts?.length ?? 0,
    draftCount: dependencies?.committed_drafts?.length ?? 0,
    backlinkCount: dependencies?.backlinks?.length ?? 0,
    eventCount: dependencies?.event_count ?? 0,
  };
}

function groupItemsByFolder(items: KnowledgeLibraryItem[]): Map<string, KnowledgeLibraryItem[]> {
  const grouped = new Map<string, KnowledgeLibraryItem[]>();
  for (const item of items) {
    const folder = item.folder_path || "Inbox";
    grouped.set(folder, [...(grouped.get(folder) ?? []), item]);
  }
  for (const [folder, folderItems] of grouped.entries()) {
    grouped.set(folder, [...folderItems].sort(compareItemsByUpdatedAt));
  }
  return grouped;
}

function compareItemsByUpdatedAt(a: KnowledgeLibraryItem, b: KnowledgeLibraryItem): number {
  return Date.parse(b.updated_at || b.created_at || "0") - Date.parse(a.updated_at || a.created_at || "0");
}

function matchesStatusFilter(item: KnowledgeLibraryItem, filter: StatusFilter): boolean {
  if (filter === "draft") return item.kind === "capture_draft";
  if (filter === "in_library") return item.kind === "capture";
  if (filter === "searchable") return item.indexed;
  if (filter === "cards") return item.garden_card_count > 0;
  return true;
}

function selectionLabel(selection: LibrarySelection, views: KnowledgeLibrarySmartView[]): string {
  if (selection.type === "all") return "所有文件";
  if (selection.type === "folder") return selection.value;
  return views.find((view) => view.key === selection.value)?.label ?? "处理队列";
}

function viewCount(views: KnowledgeLibrarySmartView[], key: string, fallback: number): number {
  return views.find((view) => view.key === key)?.count ?? fallback;
}

function NavSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="mb-5">
      <h3 className="mb-1.5 px-2 text-[0.68rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

const SidebarButton = memo(function SidebarButton({
  active,
  count,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="rounded bg-background/80 px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">{count}</span>
    </button>
  );
});

const FolderNode = memo(function FolderNode({
  active,
  editing,
  editValue,
  expanded,
  folder,
  items,
  renaming,
  selectedKey,
  onCancelRename,
  onEditValueChange,
  onOpenItem,
  onRename,
  onSelectFolder,
  onStartRename,
  onToggleFolder,
}: {
  active: boolean;
  editing: boolean;
  editValue: string;
  expanded: boolean;
  folder: KnowledgeLibraryFolder;
  items: KnowledgeLibraryItem[];
  renaming: boolean;
  selectedKey: string;
  onCancelRename: () => void;
  onEditValueChange: (value: string) => void;
  onOpenItem: (item: KnowledgeLibraryItem) => void;
  onRename: () => void;
  onSelectFolder: (folder: string) => void;
  onStartRename: (folder: KnowledgeLibraryFolder) => void;
  onToggleFolder: (folder: string) => void;
}) {
  const FolderIcon = folder.path === "Inbox" ? Inbox : Folder;
  return (
    <div>
      <div
        className={cn(
          "group flex items-center rounded-md transition",
          active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
        )}
      >
        <button
          type="button"
          onClick={() => onToggleFolder(folder.path)}
          className="flex h-8 w-7 shrink-0 items-center justify-center rounded text-muted-foreground"
          aria-label={expanded ? "收起文件夹" : "展开文件夹"}
          title={expanded ? "收起文件夹" : "展开文件夹"}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => onSelectFolder(folder.path)}
          className={cn("min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left text-sm", editing ? "hidden" : "flex")}
        >
          <FolderIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          <span className="rounded bg-background/80 px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">{folder.count}</span>
        </button>
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-1">
            <input
              autoFocus
              value={editValue}
              onChange={(event) => onEditValueChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onRename();
                if (event.key === "Escape") onCancelRename();
              }}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm outline-none focus:border-primary/40"
            />
            <button
              type="button"
              onClick={onRename}
              disabled={renaming || !editValue.trim()}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-background/80 hover:text-foreground disabled:opacity-40"
              title="确认重命名"
              aria-label="确认重命名"
            >
              {renaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={onCancelRename}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
              title="取消"
              aria-label="取消"
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          folder.path !== "Inbox" ? (
            <button
              type="button"
              onClick={() => onStartRename(folder)}
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-background/80 hover:text-foreground group-hover:opacity-100"
              title="重命名文件夹"
              aria-label="重命名文件夹"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null
        )}
      </div>
      {expanded ? (
        <div className="ml-7 mt-1 space-y-1 border-l border-border/70 pl-2">
          {items.length ? items.map((item) => (
            <FileTreeButton
              key={itemKey(item)}
              active={selectedKey === itemKey(item)}
              item={item}
              onClick={() => onOpenItem(item)}
            />
          )) : (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无文件</div>
          )}
        </div>
      ) : null}
    </div>
  );
});

const FileTreeButton = memo(function FileTreeButton({
  active,
  item,
  onClick,
}: {
  active: boolean;
  item: KnowledgeLibraryItem;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.title || "未命名文件"}</span>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.kind === "capture" ? "bg-primary" : "bg-amber-500")} />
    </button>
  );
});

const FileListItem = memo(function FileListItem({
  active,
  item,
  onClick,
}: {
  active: boolean;
  item: KnowledgeLibraryItem;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-md border px-2.5 py-2 text-left transition",
        active
          ? "border-primary/45 bg-primary/10"
          : "border-border bg-background/55 hover:border-primary/25 hover:bg-background/85",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 text-sm font-semibold leading-5">{item.title || "未命名文件"}</h3>
        <StatusBadge item={item} />
      </div>
      <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">
        {item.preview || item.summary || "暂无内容"}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[0.68rem] text-muted-foreground">
        <TinyPill>{item.folder_path || "Inbox"}</TinyPill>
        {item.indexed ? <TinyPill>可检索</TinyPill> : null}
        {item.garden_card_count > 0 ? <TinyPill>{item.garden_card_count} 张卡片</TinyPill> : null}
        <span>{formatIso(item.updated_at || item.created_at)}</span>
      </div>
    </button>
  );
});

function FileWorkbench({
  body,
  canGenerateCard,
  canPublish,
  cardGenerating,
  committing,
  deleting,
  detail,
  folder,
  folders,
  mode,
  saving,
  title,
  aiPanelOpen,
  onAiPanelToggle,
  onBodyChange,
  onDelete,
  onFolderChange,
  onGenerateCard,
  onOpenLocal,
  onPermanentDelete,
  onModeChange,
  onPublish,
  onSave,
  onStopAiOperation,
  onSelectionContextChange,
  stoppingAiOperation,
  onTitleChange,
}: {
  body: string;
  canGenerateCard: boolean;
  canPublish: boolean;
  cardGenerating: boolean;
  committing: boolean;
  deleting: boolean;
  detail: KnowledgeLibraryItem;
  folder: string;
  folders: KnowledgeLibraryFolder[];
  mode: LibraryWorkbenchMode;
  saving: boolean;
  title: string;
  aiPanelOpen: boolean;
  onAiPanelToggle: () => void;
  onBodyChange: (value: string) => void;
  onDelete: () => void;
  onFolderChange: (value: string) => void;
  onGenerateCard: () => void;
  onOpenLocal: () => void;
  onPermanentDelete: () => void;
  onModeChange: (mode: LibraryWorkbenchMode) => void;
  onPublish: () => void;
  onSave: () => void;
  onStopAiOperation?: () => void;
  onSelectionContextChange: (context: ArticleSelectionContext | null) => void;
  stoppingAiOperation?: boolean;
  onTitleChange: (value: string) => void;
}) {
  const isPublished = detail.kind === "capture";
  const canOpenLocal = isPublished && Boolean(detail.file_path);
  const canPermanentDelete = isPublished;
  const [metadataOpen, setMetadataOpen] = useState(mode === "edit");
  const [moreOpen, setMoreOpen] = useState(false);
  const busy = deleting || saving || committing || cardGenerating;
  const canStop = Boolean(onStopAiOperation) && (committing || cardGenerating);
  return (
    <>
      <div className="relative shrink-0 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StatusBadge item={detail} />
            <TinyPill>{detail.word_count || body.length} 字</TinyPill>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex h-8 rounded-md border border-border bg-background/65 p-0.5">
              <ModeButton active={mode === "browse"} icon={Eye} label="浏览模式" onClick={() => onModeChange("browse")} />
              <ModeButton active={mode === "edit"} icon={Pencil} label="编辑模式" onClick={() => onModeChange("edit")} />
            </div>
            <button
              type="button"
              onClick={() => setMetadataOpen((current) => !current)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 text-xs text-muted-foreground transition hover:border-primary/35 hover:text-foreground"
              title={metadataOpen ? "收起元信息" : "展开元信息"}
            >
              <FileText className="h-3.5 w-3.5" />
              元信息
            </button>
            {mode === "browse" ? (
              <button
                type="button"
                onClick={onAiPanelToggle}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 text-xs text-muted-foreground transition hover:border-primary/35 hover:text-foreground"
                title={aiPanelOpen ? "收起 AI 面板" : "展开 AI 面板"}
              >
                {aiPanelOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
                AI
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setMoreOpen((current) => !current)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background/65 text-muted-foreground transition hover:border-primary/35 hover:text-foreground"
              title={aiPanelOpen ? "收起 AI 面板" : "展开 AI 面板"}
              aria-label="更多"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {canStop ? (
              <button
                type="button"
                onClick={onStopAiOperation}
                disabled={stoppingAiOperation}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/35 bg-background/65 px-2 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-45"
                title={stoppingAiOperation ? "正在停止" : "停止"}
              >
                {stoppingAiOperation ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SquareStop className="h-3.5 w-3.5" />}
                {stoppingAiOperation ? "正在停止" : "停止"}
              </button>
            ) : null}
          </div>
        </div>
        {moreOpen ? (
          <div className="absolute right-4 top-14 z-20 w-56 rounded-md border border-border bg-popover p-1 shadow-lg">
            {canOpenLocal ? (
              <MenuButton icon={ExternalLink} label="用本地 App 打开" onClick={() => { setMoreOpen(false); onOpenLocal(); }} />
            ) : null}
            {isPublished ? (
              <MenuButton
                icon={Layers3}
                label={cardGenerating ? "正在生成卡片" : "生成知识卡片"}
                disabled={!canGenerateCard}
                onClick={() => { setMoreOpen(false); onGenerateCard(); }}
              />
            ) : null}
            {!isPublished ? (
              <MenuButton
                icon={Send}
                label={committing ? "正在入库" : "入库到知识库"}
                disabled={!canPublish}
                onClick={() => { setMoreOpen(false); onPublish(); }}
              />
            ) : null}
            <MenuButton
              icon={Trash2}
              label={isPublished ? "归档" : "删除"}
              tone="danger"
              disabled={busy}
              onClick={() => { setMoreOpen(false); onDelete(); }}
            />
            {canPermanentDelete ? (
              <MenuButton
                icon={XCircle}
                label="彻底删除"
                tone="danger"
                disabled={busy}
                onClick={() => { setMoreOpen(false); onPermanentDelete(); }}
              />
            ) : null}
          </div>
        ) : null}
        {mode === "edit" ? (
          <input
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            className="mt-3 w-full rounded-md border border-transparent bg-transparent px-0 py-1 text-2xl font-semibold outline-none transition focus:border-border focus:bg-background/70 focus:px-3"
            placeholder="文件标题"
          />
        ) : (
          <h2 className="mt-3 break-words text-2xl font-semibold tracking-normal text-foreground">
            {title || "未命名文件"}
          </h2>
        )}
        {mode === "edit" ? (
          <div className="mt-3 max-w-xl">
            <label className="flex items-center gap-2 rounded-md border border-border bg-background/65 px-3 py-2 text-sm">
              <span className="shrink-0 text-muted-foreground">所在文件夹</span>
              <select
                value={folder}
                onChange={(event) => onFolderChange(event.target.value)}
                className="min-w-0 flex-1 bg-transparent outline-none"
              >
                {folders.map((folderItem) => (
                  <option key={folderItem.path} value={folderItem.path}>{folderItem.name}</option>
                ))}
                {!folders.some((folderItem) => folderItem.path === folder) ? (
                  <option value={folder}>{folder}</option>
                ) : null}
              </select>
            </label>
          </div>
        ) : null}
        {metadataOpen ? (
          <div className="mt-3 grid gap-2 rounded-md border border-border bg-background/55 p-3 text-sm md:grid-cols-2">
            <MetadataRow label="所在文件夹" value={folder || "Inbox"} />
            <MetadataRow label="本地文件" value={detail.file_path || "入库后写入 Knowledge File"} />
            <MetadataRow label="AI 检索" value={detail.indexed ? "可被检索" : "尚未检索"} />
            <MetadataRow label="知识卡片" value={detail.garden_card_count > 0 ? `${detail.garden_card_count} 张` : "尚未生成"} />
            <div className="md:col-span-2">
              <div className="mb-1 text-xs text-muted-foreground">标签</div>
              <div className="flex flex-wrap gap-1.5">
                {detail.tags.length ? detail.tags.map((tag) => <TinyPill key={tag}>{tag}</TinyPill>) : <TinyPill>暂无标签</TinyPill>}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-4">
        {mode === "browse" ? (
          <ReadonlyMarkdownDocument
            body={body}
            onSelectionContextChange={onSelectionContextChange}
          />
        ) : (
          <textarea
            value={body}
            onChange={(event) => onBodyChange(event.target.value)}
            className="h-full min-h-[360px] w-full resize-none rounded-md border border-border bg-background/70 px-3 py-3 text-sm leading-7 outline-none focus:border-primary/40"
            placeholder="开始记录..."
          />
        )}
      </div>

      {(mode === "edit" || !isPublished) ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-background/95 px-4 py-3">
          {mode === "edit" ? (
            <button
              type="button"
              onClick={onSave}
              disabled={saving || deleting}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isPublished ? "保存文件" : "保存草稿"}
            </button>
          ) : null}
          {!isPublished ? (
            <button
              type="button"
              onClick={onPublish}
              disabled={!canPublish}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 text-sm font-medium text-foreground transition hover:bg-primary/15 disabled:opacity-45"
            >
              {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              入库到知识库
            </button>
          ) : null}
          {canStop ? (
            <button
              type="button"
              onClick={onStopAiOperation}
              disabled={stoppingAiOperation}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-destructive/35 bg-background/60 px-3 text-sm text-destructive transition hover:bg-destructive/10 disabled:opacity-45"
            >
              {stoppingAiOperation ? <Loader2 className="h-4 w-4 animate-spin" /> : <SquareStop className="h-4 w-4" />}
              {stoppingAiOperation ? "正在停止" : "停止"}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function MenuButton({
  disabled = false,
  icon: Icon,
  label,
  tone = "default",
  onClick,
}: {
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition disabled:opacity-45",
        tone === "danger"
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground hover:bg-background/80",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-foreground">{value}</div>
    </div>
  );
}

function CollapsedKnowledgeLeftRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="group relative hidden min-h-0 overflow-visible border-l border-border/70 bg-transparent lg:block">
      <button
        type="button"
        onClick={onExpand}
        className="absolute left-0 top-3 z-10 inline-flex h-8 w-8 -translate-x-1 items-center justify-center rounded-md border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition hover:border-primary/35 hover:text-foreground group-hover:translate-x-0 group-hover:opacity-100 focus:translate-x-0 focus:opacity-100"
        title="展开侧栏"
        aria-label="展开侧栏"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </aside>
  );
}

function ImmersiveReadingOverlay({
  body,
  title,
  onExit,
}: {
  body: string;
  title: string;
  onExit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-5">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-normal">{title}</h1>
        <button
          type="button"
          onClick={onExit}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background/70 px-3 text-sm text-muted-foreground transition hover:border-primary/35 hover:text-foreground"
          title="退出沉浸阅读"
          aria-label="退出沉浸阅读"
        >
          <Minimize2 className="h-4 w-4" />
          退出沉浸阅读
        </button>
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <article className="mx-auto max-w-4xl rounded-md border border-border bg-background/70 px-5 py-5 text-base leading-8">
          {body.trim() ? (
            <Markdown content={body} enableKnowledgeOutlineLinks />
          ) : (
            <p className="text-sm text-muted-foreground">暂无正文</p>
          )}
        </article>
      </main>
    </div>
  );
}

function ReadonlyMarkdownDocument({
  body,
  onSelectionContextChange,
}: {
  body: string;
  onSelectionContextChange: (context: ArticleSelectionContext | null) => void;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const updateSelection = useCallback(() => {
    const context = selectionContextFromDomSelection(articleRef.current);
    if (context) {
      onSelectionContextChange(context);
      return;
    }
    const selectedText = window.getSelection()?.toString().trim() ?? "";
    onSelectionContextChange(selectionContextFromSelectedText(body, selectedText));
  }, [body, onSelectionContextChange]);

  return (
    <article
      ref={articleRef}
      className="h-full min-h-[360px] overflow-y-auto rounded-md border border-border bg-background/70 px-5 py-4"
      onKeyUpCapture={updateSelection}
      onMouseUpCapture={updateSelection}
    >
      {body.trim() ? (
        <Markdown content={body} enableKnowledgeOutlineLinks />
      ) : (
        <p className="text-sm text-muted-foreground">暂无正文</p>
      )}
    </article>
  );
}

function selectionContextFromDomSelection(root: HTMLElement | null): ArticleSelectionContext | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const selectedText = selection.toString().trim();
  if (!selectedText) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeText = beforeRange.toString();
  const fullText = root.innerText || root.textContent || "";
  const selectionStart = beforeText.length;
  const selectionEnd = selectionStart + selectedText.length;
  return {
    selectedText,
    surroundingBefore: fullText.slice(Math.max(0, selectionStart - 1200), selectionStart),
    surroundingAfter: fullText.slice(selectionEnd, Math.min(fullText.length, selectionEnd + 1200)),
    headingPath: headingPathBeforeDomSelection(root, range),
    selectionStart,
    selectionEnd,
    selectionConfidence: "offset",
  };
}

function headingPathBeforeDomSelection(root: HTMLElement, range: Range): string[] {
  const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  let stack: Array<{ level: number; text: string }> = [];
  for (const heading of headings) {
    const position = heading.compareDocumentPosition(range.startContainer);
    const isBeforeSelection = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!isBeforeSelection) continue;
    const level = Number(heading.tagName.slice(1)) || 1;
    const text = (heading.textContent || "").trim();
    if (!text) continue;
    stack = stack.filter((item) => item.level < level);
    stack.push({ level, text });
  }
  return stack.map((item) => item.text).slice(-4);
}

function selectionContextFromOffsets(
  body: string,
  start: number,
  end: number,
): ArticleSelectionContext | null {
  if (start === end) return null;
  const selectionStart = Math.max(0, Math.min(start, end));
  const selectionEnd = Math.min(body.length, Math.max(start, end));
  const selectedText = body.slice(selectionStart, selectionEnd).trim();
  if (!selectedText) return null;
  return {
    selectedText,
    surroundingBefore: body.slice(Math.max(0, selectionStart - 1200), selectionStart),
    surroundingAfter: body.slice(selectionEnd, Math.min(body.length, selectionEnd + 1200)),
    headingPath: headingPathBefore(body.slice(0, selectionStart)),
    selectionStart,
    selectionEnd,
    selectionConfidence: "offset",
  };
}

function selectionContextFromSelectedText(
  body: string,
  selectedText: string,
): ArticleSelectionContext | null {
  selectedText = selectedText.trim();
  if (!selectedText) return null;
  const exactStart = body.indexOf(selectedText);
  if (exactStart >= 0) {
    return selectionContextFromOffsets(body, exactStart, exactStart + selectedText.length);
  }
  return {
    selectedText,
    surroundingBefore: "",
    surroundingAfter: "",
    headingPath: [],
    selectionConfidence: "text_only",
  };
}

function headingPathBefore(markdown: string): string[] {
  let stack: Array<{ level: number; text: string }> = [];
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();
    stack = stack.filter((item) => item.level < level);
    stack.push({ level, text });
  }
  return stack.slice(-3).map((item) => item.text);
}

function ModeButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2.5 text-xs font-medium transition",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function ArticleAIPanel({
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
  researchMode: KnowledgeResearchMode;
  question: string;
  savingAnswerId: string;
  onAsk: () => void;
  onAskPrompt: (prompt: string) => void;
  onClose: () => void;
  onQuestionChange: (value: string) => void;
  onResearchModeChange: (mode: KnowledgeResearchMode) => void;
  onRerun: (message: ArticleChatMessage, mode: KnowledgeResearchMode, forceWeb?: boolean) => void;
  onOpenSource: (source: KnowledgeResearchSource) => void;
  onOpenSourceLocal: (source: KnowledgeResearchSource) => void;
  onSaveAnswer: (message: ArticleChatMessage, outputType: "local_learning_note" | "knowledge_card") => void;
  onStop: () => void;
}) {
  const hasPendingAssistant = messages.some((message) => message.role === "assistant" && message.pending);
  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-lg border border-border/80 bg-background xl:flex">
      <div className="shrink-0 border-b border-border/70 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold" title={detail.title || "未命名文件"}>AI 伴读</h2>
            <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
              结合当前资料与知识库，解惑、追问、一键提炼卡片
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
              title="收起 AI 面板"
              aria-label="收起 AI 面板"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
        </div>
        <ResearchModeControl
          disabled={loading}
          mode={researchMode}
          onChange={onResearchModeChange}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {messages.length ? (
          <div className="space-y-2.5">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm leading-6",
                  message.role === "user"
                    ? "border-primary/15 bg-primary/5"
                    : "border-border/75 bg-background/45",
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
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        选区：{message.selectionPreview}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ))}
            {loading && !hasPendingAssistant ? (
              <LoadingState
                text={researchMode === "web_only"
                  ? "正在搜索并读取网页..."
                  : "AI 正在回答..."}
              />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <EmptyState text="划选正文中的一段话，或直接输入问题；AI 会结合当前资料与知识库为你解惑。" />
            <div className="flex flex-wrap gap-1.5">
              {ARTICLE_AI_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  disabled={loading}
                  onClick={() => onAskPrompt(starter.prompt)}
                  className="rounded-full border border-border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-45"
                >
                  {starter.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        {chatError ? (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/8 px-2 py-1.5 text-xs text-destructive">
            {chatError}
          </div>
        ) : null}
        <textarea
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            if (!loading && question.trim()) onAsk();
          }}
          className="h-24 w-full resize-none rounded-md border border-border bg-background/70 px-3 py-2 text-sm leading-6 outline-none focus:border-primary/40"
          placeholder="问 AI..."
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={loading ? onStop : onAsk}
            disabled={loading ? false : !question.trim()}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition hover:opacity-90 disabled:opacity-45",
              loading
                ? "border border-destructive/35 bg-destructive/10 text-destructive"
                : "bg-primary text-primary-foreground",
            )}
          >
            {loading ? <SquareStop className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {loading ? "停止" : "发送"}
          </button>
        </div>
      </div>
    </aside>
  );
}

function CollapsedAIPanelRail({
  className,
  loading,
  onOpen,
}: {
  className?: string;
  loading: boolean;
  onOpen: () => void;
}) {
  return (
    <aside
      className={cn(
        "group relative hidden min-h-0 overflow-visible border-r border-border/70 bg-transparent xl:block",
        className,
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="absolute right-0 top-3 z-10 inline-flex h-8 w-8 translate-x-1 items-center justify-center rounded-md border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition hover:border-primary/35 hover:text-foreground group-hover:translate-x-0 group-hover:opacity-100 focus:translate-x-0 focus:opacity-100"
      title="展开 AI 面板"
      aria-label="展开 AI 面板"
    >
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}

function selectionChatHistory(messages: ArticleChatMessage[]): KnowledgeChatHistoryMessage[] {
  return successfulArticleChatPairs(messages)
    .slice(-6)
    .flatMap(([user, assistant]) => [
      { role: "user" as const, content: articleHistoryUserContent(user) },
      { role: "assistant" as const, content: assistant.content },
    ]);
}

function selectionChatHistoryOverflow(messagesByMode: ArticleChatMessagesByMode): KnowledgeChatHistoryMessage[] {
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

function successfulArticleChatPairs(messages: ArticleChatMessage[]): Array<[ArticleChatMessage, ArticleChatMessage]> {
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

function articleHistoryUserContent(message: ArticleChatMessage): string {
  const selection = (message.requestContext?.selected_text || "").trim();
  if (!selection) return message.content;
  return `[当轮选区: ${selection.slice(0, 300)}] ${message.content}`;
}

function markCompressedHistoryMessages(
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

function ResearchModeControl({
  disabled,
  mode,
  onChange,
}: {
  disabled: boolean;
  mode: KnowledgeResearchMode;
  onChange: (mode: KnowledgeResearchMode) => void;
}) {
  const webEnabled = mode === "local_web" || mode === "web_only";
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={webEnabled}
        onClick={() => onChange(webEnabled ? "current_article_only" : "local_web")}
        title={
          webEnabled
            ? "关闭联网搜索，仅使用当前笔记与个人知识库"
            : "开启 DeepSeek 联网搜索，与个人知识库联合解答"
        }
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition",
          webEnabled
            ? "border-primary/50 bg-primary/15 font-medium text-primary"
            : "border-border bg-background/80 text-muted-foreground hover:border-primary/40 hover:text-foreground",
          disabled && "opacity-45",
        )}
      >
        🌐 联网搜索{webEnabled ? " · 已开启" : ""}
      </button>
      <span className="min-w-0 truncate text-[11px] leading-5 text-muted-foreground">
        {webEnabled ? "⚡ DeepSeek 联网搜索 + 个人知识库联合解答" : "📚 当前笔记 + 个人知识库"}
      </span>
    </div>
  );
}

function pendingResearchTrace(
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

function applySelectionChatStreamEvent(
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
      providerStatus.stage = "正在检索本地知识库";
      setProgressContent("正在检索本地知识库...");
      break;
    case "local_search_done":
      trace.knowledge_sources = mergeResearchSources(trace.knowledge_sources, event.knowledge_sources);
      providerStatus.stage = "本地知识库检索完成";
      setProgressContent("本地知识库检索完成，继续整理证据...");
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

function mergeQueryStatuses(
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

function mergeResearchSources(
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

function ArticleAssistantAnswer({
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

function articleAssistantRerunAction(message: ArticleChatMessage): { label: string; mode: KnowledgeResearchMode; forceWeb?: boolean } | null {
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

function ArticleReasoningTrace({ message }: { message: ArticleChatMessage }) {
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

function reasoningTraceDisplay(trace: NonNullable<KnowledgeLibrarySelectionChatResponse["meta"]>["reasoning_trace"]): string {
  const value = trace?.api_reasoning ?? trace?.reasoning_summary ?? trace?.fallback_reason ?? "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const ArticleResearchProcess = memo(function ArticleResearchProcess({ message }: { message: ArticleChatMessage }) {
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

function ResearchProgress({
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

function directAnswerContextLabels(
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

const ResearchSourceGroup = memo(function ResearchSourceGroup({
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

function ResearchAuditDetails({
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function queryStatusArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function queryStatusLabel(value: unknown): string {
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

function queryStatusTone(value: unknown): string {
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

function readableResearchWarnings(
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

function traceSourceCount(sources: unknown): number {
  return Array.isArray(sources) ? sources.length : 0;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function providerNumber(providerStatus: unknown, key: string): number {
  if (!providerStatus || typeof providerStatus !== "object") return 0;
  return numberField((providerStatus as Record<string, unknown>)[key]);
}

function sourceArray(sources: unknown): KnowledgeResearchSource[] {
  return Array.isArray(sources) ? sources.filter((source): source is KnowledgeResearchSource => Boolean(source && typeof source === "object")) : [];
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function researchSummaryText({
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
      if (mode === "local_only" || mode === "local_web") return "正在检索知识库";
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

function researchProgressFallback({
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
  if (mode === "local_only") return pending ? "正在检索知识库" : "知识库检索完成";
  if (mode === "local_web") {
    if (pending) return "正在检索知识库";
    return knowledgeCount ? "未联网，已用知识库回答" : "未联网";
  }
  return pending ? "正在回答" : "回答完成";
}

function researchStatusTitle(mode: KnowledgeResearchMode | undefined, webSearchAttempted: boolean): string {
  if (webSearchAttempted || mode === "web_only") return "搜索状态";
  if (mode === "local_only" || mode === "local_web") return "检索状态";
  return "生成状态";
}

function researchElapsedLabel(
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

function formatElapsedMs(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} 秒`;
}

function researchSourceReasonLabel(reason: string): string {
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

function researchEvidenceRoleLabel(role: string): string {
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

function researchModeLabel(mode: KnowledgeResearchMode): string {
  switch (mode) {
    case "current_article_only":
      return "当前文章";
    case "local_only":
      return "知识库";
    case "local_web":
      return "联网搜索 + 知识库";
    case "web_only":
      return "联网";
    case "theme_scan":
      return "跨篇灵感扫描";
  }
}

function researchStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned_web_forced_by_mode: "按模式强制联网",
    planned: "已规划",
    planned_web: "已规划联网",
    skipped_web: "跳过联网",
  };
  return labels[status] ?? status;
}

function providerStatusLabels(status: Record<string, unknown> | undefined): string[] {
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

function providerStatusName(name: string): string {
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

function providerStatusValue(name: string, value: unknown): string {
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

function stageTimingLabel(timings: Record<string, unknown>): string {
  const labels: Array<[string, string]> = [
    ["planning_ms", "规划"],
    ["local_search_ms", "知识库"],
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

function FilterButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2.5 py-1.5 text-xs transition",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-background/65 text-muted-foreground hover:bg-background/90 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function StatusBadge({ item }: { item: KnowledgeLibraryItem }) {
  const label = item.kind === "capture" ? "已入库" : "草稿";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[0.68rem] font-medium",
        item.kind === "capture"
          ? "bg-emerald-500/10 text-emerald-700"
          : "bg-amber-500/10 text-amber-700",
      )}
    >
      {label}
    </span>
  );
}

function TinyPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-background/70 px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">
      {children}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background/60 px-2 py-1.5">
      <div className="text-[0.65rem] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function LoadingState({ text }: { text: string }) {
  return (
    <div className="flex min-h-[220px] items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
  );
}

function EmptyState({
  text,
  onCreate,
  onImport,
}: {
  text: string;
  onCreate?: () => void;
  onImport?: () => void;
}) {
  return (
    <div className="flex min-h-[260px] items-center justify-center px-4 text-center">
      <div className="max-w-sm">
        <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium leading-6 text-foreground">{text}</p>
        {(onCreate || onImport) ? (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            可以从粘贴材料、空白文件或本地 Markdown 导入开始。
          </p>
        ) : null}
        {(onCreate || onImport) ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {onCreate ? (
              <button
                type="button"
                onClick={onCreate}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition hover:bg-muted"
              >
                <FilePlus2 className="h-3.5 w-3.5" />
                新建知识文件
              </button>
            ) : null}
            {onImport ? (
              <button
                type="button"
                onClick={onImport}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition hover:bg-muted"
              >
                <UploadCloud className="h-3.5 w-3.5" />
                导入文件
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
