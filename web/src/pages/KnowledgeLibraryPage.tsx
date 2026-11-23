import {
  type ChangeEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  CircleAlert,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  createAiOperationId,
  KnowledgeSelectionChatStreamError,
  type KnowledgeCaptureDraft,
  type KnowledgeLibraryFolder,
  type KnowledgeLibraryItem,
  type KnowledgeLibrarySelectionChatStreamEvent,
  type KnowledgeLibrarySmartView,
  type KnowledgeResearchMode,
  type KnowledgeResearchSource,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { ResizableRail, readStoredWidth } from "@/components/ResizableRail";
import { KnowledgeLibraryHeader } from "@/pages/KnowledgeLibraryHeader";
import { KnowledgeLibrarySidebar } from "@/pages/knowledge-library/KnowledgeLibrarySidebar";
import {
  articleQuestionForMessage,
  bridgeMetaString,
  buildGardenDraftInstruction,
  editableAiSuggestionsStatus,
  editableCardSuggestion,
  editableDraftTitleSource,
  editableFolderSuggestion,
  firstGardenCardHint,
  formatEditableCardSuggestions,
  gardenDraftError,
  gardenDraftNotice,
  groupItemsByFolder,
  isAbortError,
  isAiCancelledResult,
  isLibraryNotFoundError,
  libraryDeleteConfirmMessage,
  libraryDeleteNotice,
  libraryHasBlockingDependencies,
  libraryPermanentDeleteBlockedMessage,
  libraryPermanentDeleteConfirmMessage,
  libraryPermanentDeleteNotice,
  matchesStatusFilter,
  parseCardSuggestionsText,
  parseTagsText,
  selectionLabel,
  stringValue,
} from "@/pages/knowledge-library/helpers";
import {
  EmptyState,
  LoadingState,
} from "@/pages/knowledge-library/shared";
import {
  type LibrarySelection,
  type StatusFilter,
  itemKey,
} from "@/pages/knowledge-library/model";
import { CollapsedAIPanelRail } from "@/pages/knowledge-library/CollapsedAIPanelRail";
import { type ArticleSelectionContext } from "@/pages/knowledge-library/selection";
import { ImmersiveReadingOverlay } from "@/pages/knowledge-library/ReadingOverlay";
import { useWorkspaceChrome } from "@/contexts/WorkspaceChromeContext";
import {
  EditableCaptureWorkbench,
  type EditableCardCommitStatus,
  type EditableCaptureStatus,
} from "@/pages/knowledge-chat/EditableCaptureWorkbench";
import {
  analyzeKnowledgeOutlineMarkdown,
  repairKnowledgeOutlineMarkdown,
} from "@/lib/markdownNavigation";

import {
  FileWorkbench,
  type LibraryWorkbenchMode,
} from "@/pages/knowledge-library/FileWorkbench";
import { ArticleAIPanel } from "@/pages/knowledge-library/ArticleAIPanel";
import {
  type ArticleAiRequestContext,
  type ArticleChatMessage,
  type ArticleChatMessagesByMode,
  type ArticleResearchMode,
  EMPTY_ARTICLE_CHAT_MESSAGES,
  applySelectionChatStreamEvent,
  articleChatModeKey,
  articleSourcesForSave,
  markCompressedHistoryMessages,
  pendingResearchTrace,
  selectionChatHistory,
  selectionChatHistoryOverflow,
  uniqueStrings,
} from "@/pages/knowledge-library/articleChatModel";

type LibraryMode = "files" | "paste";
type ArticleAIPanelMode = "collapsed" | "assist" | "focus";
type AiOperationState = { id: string; label: string; controller: AbortController; stopping: boolean } | null;

const DEFAULT_SELECTION: LibrarySelection = { type: "all", value: "all" };
const DEFAULT_EXPANDED_FOLDERS = new Set(["Inbox"]);

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
  const [selectedKey, updateSelectedKey] = useState("");
  const selectedKeyRef = useRef("");
  const detailSelectionRef = useRef(0);
  const detailRequestRef = useRef(0);
  const listRequestRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const setSelectedKey = useCallback((key: string) => {
    if (selectedKeyRef.current === key) return;
    selectedKeyRef.current = key;
    detailSelectionRef.current += 1;
    detailRequestRef.current += 1;
    updateSelectedKey(key);
  }, []);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED_FOLDERS),
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loadedDetail, setDetail] = useState<KnowledgeLibraryItem | null>(null);
  const detail = loadedDetail && itemKey(loadedDetail) === selectedKey ? loadedDetail : null;
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
  const [createdCardDraftId, setCreatedCardDraftId] = useState("");
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
  const [articleResearchMode, setArticleResearchMode] = useState<ArticleResearchMode>("current_article_only");
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
    setAiOperation({ ...aiOperation, stopping: true });
    setNotice("已请求停止，等待服务确认。");
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
      || draftBody !== (detail.body ?? detail.preview ?? "")
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
    if (mode === "paste" && (aiOperation || deleting)) return false;
    if (!hasUnsavedChanges) return true;
    return window.confirm("当前文件有未保存更改，确定离开吗？");
  }, [aiOperation, deleting, hasUnsavedChanges, mode]);

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
    const request = ++listRequestRef.current;
    const selectionVersion = detailSelectionRef.current;
    const isUnfiltered = !selectedFolder && !selectedView && !query.trim();
    setLoadingItems(true);
    setError("");
    try {
      const payload = await api.getKnowledgeLibraryItems({
        folder: selectedFolder,
        view: selectedView,
        search: query,
        limit: isUnfiltered ? 500 : 300,
      });
      if (request !== listRequestRef.current) return;
      setItems(payload.items);
      if (isUnfiltered) setAllItems(payload.items);
      if (selectionVersion !== detailSelectionRef.current) return;
      const current = selectedKeyRef.current;
      if (current && payload.items.some((item) => itemKey(item) === current)) return;
      setSelectedKey(payload.items[0] ? itemKey(payload.items[0]) : "");
    } catch (err) {
      if (request !== listRequestRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
      if (selectionVersion === detailSelectionRef.current) setSelectedKey("");
    } finally {
      if (request === listRequestRef.current) setLoadingItems(false);
    }
  }, [query, selectedFolder, selectedView, setSelectedKey]);

  const applyDetail = useCallback((item: KnowledgeLibraryItem) => {
    setDetail(item);
    setDraftTitle(item.title);
    setDraftBody(item.body ?? item.preview ?? "");
    setDraftFolder(item.folder_path || "Inbox");
  }, []);

  const loadDetail = useCallback(async (item: Pick<KnowledgeLibraryItem, "kind" | "id"> | null) => {
    if (item && `${item.kind}:${item.id}` !== selectedKeyRef.current) return;
    const request = ++detailRequestRef.current;
    if (!item) {
      setDetail(null);
      setDraftTitle("");
      setDraftBody("");
      setDraftFolder("Inbox");
      setLoadingDetail(false);
      return;
    }
    setLoadingDetail(true);
    setError("");
    try {
      const payload = await api.getKnowledgeLibraryItem(item.kind, item.id);
      if (request === detailRequestRef.current) applyDetail(payload.item);
    } catch (err) {
      if (request !== detailRequestRef.current) return;
      if (isLibraryNotFoundError(err)) {
        setDetail(null);
        setLoadingDetail(false);
        setSelectedKey("");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === detailRequestRef.current) setLoadingDetail(false);
    }
  }, [applyDetail, setSelectedKey]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    const [kind, ...idParts] = selectedKey.split(":");
    const id = idParts.join(":");
    void loadDetail(id && (kind === "capture" || kind === "capture_draft") ? { kind, id } : null);
  }, [loadDetail, selectedKey]);

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
    clearRouteParams();
  }, [allItems, loadingItems, searchParams, setSearchParams, setSelectedKey]);

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
  }, [mode, selectedItem, selectedKey, setSelectedKey, visibleItems]);

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
  }, [confirmLeaveCurrentWork, setSelectedKey, switchMode]);

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
    if (!detail || saveInFlightRef.current || itemKey(detail) !== selectedKeyRef.current) return false;
    saveInFlightRef.current = true;
    const selectionVersion = detailSelectionRef.current;
    const isCurrent = () => selectionVersion === detailSelectionRef.current;
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
        if (isCurrent()) await loadDetail(detail);
      } else {
        const payload = await api.updateKnowledgeLibraryItem(detail.kind, detail.id, {
          title: draftTitle,
          body: bodyToSave,
          folder_path: draftFolder,
        });
        if (isCurrent()) applyDetail(payload.item);
      }
      if (options.refresh !== false) {
        if (isCurrent()) await refreshAll();
        else await loadAllItems();
      }
      if (!options.silent && isCurrent()) setNotice("已保存。");
      return true;
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [applyDetail, detail, draftBody, draftFolder, draftTitle, loadAllItems, loadDetail, refreshAll]);

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
  }): Promise<{ drafted: boolean; error?: string }> => {
    if (!shouldGenerate) return { drafted: false };
    const captureId = (
      bridgeMetaString(commitResult, "capture_id")
      || bridgeMetaString(commitResult, "committed_capture_id")
      || draft.committed_capture_id
    );
    if (!captureId) {
      return { drafted: false, error: "保存成功，但没有拿到 Capture ID。" };
    }
    try {
      onStage?.("正在生成知识卡片草稿...");
      const cardHint = firstGardenCardHint(suggestionsText);
      const result = await api.createKnowledgeGardenDraft({
        capture_ids: [captureId],
        title: cardHint.title,
        card_kind: cardHint.card_kind,
        instruction: buildGardenDraftInstruction(reason, suggestionsText),
      }, operationId ? { operationId } : undefined);
      if (isAiCancelledResult(result)) {
        return { drafted: false, error: "已停止。" };
      }
      if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
        throw new Error(gardenDraftError(result));
      }
      return { drafted: true };
    } catch (err) {
      return {
        drafted: false,
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
      setNotice("正在写入资料库文件...");
      const commitResult = await api.commitKnowledgeCaptureDraft(detail.id, { operationId: operation.operationId });
      if (isAiCancelledResult(commitResult)) {
        setNotice("已停止。草稿仍保留，可继续编辑或重试保存。");
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
      if (cardResult.drafted) {
        setNotice("已保存到资料库，并生成知识卡片草稿。请到知识卡片板确认保存。");
      } else if (cardResult.error) {
        setNotice(`已保存，但知识卡片草稿生成失败：${cardResult.error}`);
      } else {
        setNotice("保存完成。");
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
  }, [detail, refreshAll, setSelectedKey]);

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
  }, [detail, refreshAll, setSelectedKey]);

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
    setCreatedCardDraftId("");
    setNotice("正在生成知识卡片草稿...");
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
      const draftId = typeof result.meta?.draft_id === "string" ? result.meta.draft_id.trim() : "";
      if (draftId) setCreatedCardDraftId(draftId);
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
    setSelectedKey,
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
          ? await api.regenerateKnowledgeEditableCaptureDraft(editableDraft.id, {
            content,
            title: editableTitle,
            title_source: editableTitleSource,
            folder_path: draftFolderPath,
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
      setEditableProgressMessage("整理完成，可以保存");
      await refreshAll();
      setNotice("已生成 AI 建议，可以继续编辑或保存。");
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
    setSelectedKey,
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
  }, [editableDraft, editableTitle, refreshAll, selectedFolder, setSelectedKey]);

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
      setEditableProgressMessage("正在写入资料库文件...");
      const commitResult = await api.commitKnowledgeCaptureDraft(draft.id, {
        operationId: operation.operationId,
        signal: operation.signal,
      });
      if (operation.isCancelled() || isAiCancelledResult(commitResult)) {
        setEditableStatus("ready_to_commit");
        setEditableProgressMessage("已停止，草稿仍保留");
        setNotice("已停止。草稿仍保留，可继续编辑或重试保存。");
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
      setEditableCardCommitStatus(cardResult.drafted ? "drafted" : cardResult.error ? "failed" : "skipped");
      setEditableProgressMessage("保存完成");
      await refreshAll();
      if (cardResult.drafted) {
        setNotice(`已保存到资料库，并生成知识卡片草稿：《${payload.draft.title || "未命名草稿"}》。请到知识卡片板确认保存。`);
      } else if (cardResult.error) {
        setNotice(`已保存，但知识卡片草稿生成失败：${cardResult.error}`);
      } else {
        setNotice(`已保存到资料库：《${payload.draft.title || "未命名草稿"}》。`);
      }
    } catch (err) {
      if (operation.isCancelled() || isAbortError(err)) {
        setEditableStatus("ready_to_commit");
        setEditableProgressMessage("已请求停止，可继续编辑或重试");
        setNotice("已请求停止。草稿仍保留，可继续编辑或重试保存。");
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
    setSelectedKey,
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

  const askArticleAi = useCallback(async (override?: { question?: string; mode?: ArticleResearchMode; requestContext?: ArticleAiRequestContext }) => {
    if (!detail || chatLoading) return;
    const requestContext = override?.requestContext;
    const question = (requestContext?.question ?? override?.question ?? chatQuestion).trim();
    const rawMode: KnowledgeResearchMode =
      requestContext?.mode ?? override?.mode ?? articleResearchMode;
    // web_only is API/eval-only. Historical answers may still carry it; rerun
    // as local_web with force_web so the "must search the web" intent survives.
    const requestMode: ArticleResearchMode =
      rawMode === "local_web" || rawMode === "web_only" ? "local_web" : "current_article_only";
    const requestForceWeb = rawMode === "web_only" || requestMode === "local_web";
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
      force_web: requestForceWeb,
    };
    requestBody.history = selectionChatHistory(modeMessages);
    requestBody.history_summary = historySummary;
    requestBody.history_summary_version = historySummaryVersion;
    requestBody.history_overflow = selectionChatHistoryOverflow(chatMessagesByMode);
    requestBody.mode = requestMode;
    requestBody.force_web = requestForceWeb;
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
      // Fall back only when the stream endpoint explicitly rejected the
      // request. A network drop or a stream error after acceptance may still
      // be running on the service; replaying it would create a duplicate
      // answer or draft.
      const canFallback = err instanceof KnowledgeSelectionChatStreamError
        && !err.requestAccepted
        && !sawProgressEvent;
      if (!canFallback) {
        const message = err instanceof Error ? err.message : String(err);
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
        return;
      }
      try {
        const response = await api.selectionChatKnowledgeLibraryItem(
          detail.kind,
          detail.id,
          requestBody,
          streamController.signal,
        );
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
          warnings: [...(response.warnings || []), "实时流式连接未建立，已回退到普通请求。"],
        };
        applyHistorySummaryUpdate(response.meta?.updated_history_summary, response.meta?.updated_history_summary_version);
        setChatMessagesForMode(requestMode, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? assistantMessage : message,
          ),
        );
      } catch (fallbackErr) {
        if (streamController.signal.aborted) {
          const stoppedMessage = streamTimedOut ? "生成超时，已停止。" : "已停止生成。";
          if (streamTimedOut) setChatError(stoppedMessage);
          markArticleAiStopped(assistantId, stoppedMessage);
          return;
        }
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
    const requestMode: ArticleResearchMode =
      mode === "local_web" || mode === "web_only" ? "local_web" : "current_article_only";
    void askArticleAi({
      requestContext: {
        ...baseContext,
        mode: requestMode,
        force_web: forceWeb || mode === "web_only" || requestMode === "local_web",
      },
    });
  }, [askArticleAi]);

  const saveArticleAiAnswer = useCallback(async (
    message: ArticleChatMessage,
    outputType: "local_learning_note" | "knowledge_card",
  ) => {
    if (!detail || message.role !== "assistant") return;
    const question = articleQuestionForMessage(chatMessages, message);
    if (!question) {
      setChatError("找不到这条回答对应的问题，无法保存。");
      return;
    }
    setSavingArticleAnswerId(message.id);
    setChatError("");
    try {
      const result = await api.createKnowledgeAnswerDraft({
        hermes_session_id: "knowledge-library",
        user_message: question,
        assistant_answer: message.content,
        instruction: outputType === "knowledge_card" ? "把资料库右侧 AI 回答做成卡片" : "把资料库右侧 AI 回答存成资料笔记",
        output_type: outputType,
        assistant_message_id: message.id,
        sources: articleSourcesForSave(message.sources, detail),
        answer_source: message.responseMeta?.source_run_id ? "auto" : "provided",
        source_run_id: message.responseMeta?.source_run_id,
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
  }, [chatMessages, detail, navigate, refreshAll]);

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
      setNotice("这个资料库来源暂时缺少可打开的本地文件信息。");
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
  }, [allItems, confirmLeaveCurrentWork, navigate, setSelectedKey, switchMode]);

  const openKnowledgeSourceLocal = useCallback(async (source: KnowledgeResearchSource) => {
    const itemId = String(source.item_id || "").trim();
    if (source.item_kind !== "capture" || !itemId) {
      setNotice("这个资料库来源暂时缺少可打开的本地文件信息。");
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
            "flex shrink-0 items-center justify-between gap-3 rounded-lg border px-3.5 py-2 text-xs",
            error
              ? "border-destructive/30 bg-destructive/8 text-destructive"
              : "border-border/70 bg-muted/45 text-foreground",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {error ? <CircleAlert className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-foreground" />}
            <span className="min-w-0 truncate">{error || notice}</span>
          </div>
          {!error && createdCardDraftId ? (
            <button
              type="button"
              onClick={() => navigate(`/cards-board?draft=${encodeURIComponent(createdCardDraftId)}`)}
              className="shrink-0 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition hover:opacity-90"
            >
              立即去审阅编辑 →
            </button>
          ) : null}
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
	          <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-black/[0.07] bg-white/95 dark:border-border dark:bg-card">
            <EditableCaptureWorkbench
              activityPending={Boolean(aiOperation || deleting)}
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
              onStopAiOperation={aiOperation ? stopAiOperation : undefined}
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
	            <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-black/[0.07] bg-white/95 dark:border-border dark:bg-card">
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
	                  onStopAiOperation={aiOperation ? stopAiOperation : undefined}
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
