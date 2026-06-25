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
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  Layers3,
  Loader2,
  MoreHorizontal,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  type KnowledgeCaptureDraft,
  type KnowledgeGardenDraftResponse,
  type KnowledgeLibraryDependencies,
  type KnowledgeLibraryDeleteResponse,
  type KnowledgeLibraryFolder,
  type KnowledgeLibraryItem,
  type KnowledgeLibrarySelectionChatResponse,
  type KnowledgeLibrarySelectionChatStreamEvent,
  type KnowledgeLibrarySmartView,
  type KnowledgeResearchMode,
  type KnowledgeResearchSource,
  type KnowledgeResearchTrace,
} from "@/lib/api";
import { cn, isoTimeAgo } from "@/lib/utils";
import { ResizableRail, readStoredWidth } from "@/components/ResizableRail";
import {
  EditableCaptureWorkbench,
  type EditableCaptureStatus,
} from "@/pages/knowledge-chat/EditableCaptureWorkbench";
import { Markdown } from "@/components/Markdown";

type LibrarySelection =
  | { type: "all"; value: "all" }
  | { type: "folder"; value: string }
  | { type: "view"; value: string };

type LibraryMode = "files" | "paste";
type LibraryWorkbenchMode = "browse" | "edit";
type StatusFilter = "all" | "draft" | "in_library" | "searchable" | "cards";
type ArticleAIPanelMode = "collapsed" | "assist" | "focus";

interface ArticleSelectionContext {
  selectedText: string;
  surroundingBefore: string;
  surroundingAfter: string;
  headingPath: string[];
  selectionStart?: number;
  selectionEnd?: number;
  selectionConfidence: "offset" | "text_only" | "none";
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
  researchEvents?: ResearchTimelineEvent[];
  warnings?: string[];
}

interface ResearchTimelineEvent {
  key: string;
  label: string;
  detail?: string;
  at: string;
  tone?: "normal" | "warning" | "error" | "success";
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
const KNOWLEDGE_AI_WIDTH_KEY = "hermes.knowledgeLibrary.aiWidth";
const KNOWLEDGE_AI_FOCUS_WIDTH_KEY = "hermes.knowledgeLibrary.aiFocusWidth";
const DEFAULT_KNOWLEDGE_LEFT_WIDTH = 360;
const DEFAULT_KNOWLEDGE_AI_WIDTH = 380;
const DEFAULT_KNOWLEDGE_AI_FOCUS_WIDTH = 520;

export default function KnowledgeLibraryPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const libraryLayoutRef = useRef<HTMLDivElement | null>(null);
  const articleLayoutRef = useRef<HTMLDivElement | null>(null);
  const [selectionContext, setSelectionContext] = useState<ArticleSelectionContext | null>(null);
  const [chatMessages, setChatMessages] = useState<ArticleChatMessage[]>([]);
  const [chatQuestion, setChatQuestion] = useState("");
  const [articleResearchMode, setArticleResearchMode] = useState<KnowledgeResearchMode>("local_web");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const chatStreamAbortRef = useRef<AbortController | null>(null);
  const [savingArticleAnswerId, setSavingArticleAnswerId] = useState("");
  const [editableContent, setEditableContent] = useState("");
  const [editableTitle, setEditableTitle] = useState("");
  const [editableSummary, setEditableSummary] = useState("");
  const [editableTagsText, setEditableTagsText] = useState("");
  const [editableSource, setEditableSource] = useState("");
  const [editableFolder, setEditableFolder] = useState("Inbox");
  const [editableFolderSuggestionMode, setEditableFolderSuggestionMode] = useState<"existing" | "new">("existing");
  const [editableFolderSuggestionReason, setEditableFolderSuggestionReason] = useState("");
  const [editableGenerateCard, setEditableGenerateCard] = useState(false);
  const [editableCardReason, setEditableCardReason] = useState("");
  const [editableCardSuggestionsText, setEditableCardSuggestionsText] = useState("");
  const [editableDraft, setEditableDraft] = useState<KnowledgeCaptureDraft | null>(null);
  const [editableStatus, setEditableStatus] = useState<EditableCaptureStatus>("empty");
  const [editableError, setEditableError] = useState("");

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
    setSelectionContext(null);
    setChatMessages([]);
    setChatQuestion("");
    setChatError("");
    setChatLoading(false);
  }, [selectedKey]);

  useEffect(() => {
    return () => {
      chatStreamAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (searchParams.get("mode") === "paste") {
      setMode("paste");
    }
  }, [searchParams]);

  useEffect(() => {
    if (mode !== "files") return;
    if (!visibleItems.length) {
      setSelectedKey("");
      return;
    }
    if (!visibleItems.some((item) => itemKey(item) === selectedKey)) {
      setSelectedKey(itemKey(visibleItems[0]));
    }
  }, [mode, selectedKey, visibleItems]);

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
    setEditableSummary("");
    setEditableTagsText("");
    setEditableSource(sourceLabel);
    setEditableFolder(folder);
    setEditableFolderSuggestionMode("existing");
    setEditableFolderSuggestionReason("");
    setEditableGenerateCard(false);
    setEditableCardReason("");
    setEditableCardSuggestionsText("");
    setEditableError("");
    setEditableStatus("empty");
    setNewMenuOpen(false);
    switchMode("paste");
  }, [confirmLeaveCurrentWork, draftFolder, selectedFolder, switchMode]);

  const createFile = useCallback(() => {
    startEditableEntry("空白文件");
  }, [startEditableEntry]);

  const pasteAndOrganize = useCallback(() => {
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
      setEditableSummary("");
      setEditableTagsText("");
      setEditableSource(file.name);
      setEditableFolder(selectedFolder || draftFolder || "Inbox");
      setEditableFolderSuggestionMode("existing");
      setEditableFolderSuggestionReason("");
      setEditableGenerateCard(false);
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
      const payload = await api.updateKnowledgeLibraryItem(detail.kind, detail.id, {
        title: draftTitle,
        body: draftBody,
        folder_path: draftFolder,
      });
      setDetail(payload.item);
      setSelectedKey(itemKey(payload.item));
      if (options.refresh !== false) await refreshAll();
      if (!options.silent) setNotice("已保存。");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [detail, draftBody, draftFolder, draftTitle, refreshAll]);

  const commitDraft = useCallback(async () => {
    if (!detail || detail.kind !== "capture_draft") return;
    setCommitting(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveDetail();
      if (!saved) return;
      await api.commitKnowledgeCaptureDraft(detail.id);
      await refreshAll();
      setNotice("已入库到知识库。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }, [detail, refreshAll, saveDetail]);

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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [detail, refreshAll]);

  const generateCard = useCallback(async () => {
    if (!detail || detail.kind !== "capture") return;
    setCardGenerating(true);
    setError("");
    setNotice("正在生成卡片...");
    try {
      const saved = await saveDetail({ refresh: false, silent: true });
      if (!saved) return;
      const result = await api.createKnowledgeGardenDraft({ capture_ids: [detail.id] });
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
    }
  }, [detail, loadDetail, refreshAll, saveDetail]);

  const saveEditableCaptureDraft = useCallback(async (
    options: { preserveEditableMetadata?: boolean; folderPath?: string } = {},
  ): Promise<KnowledgeCaptureDraft | null> => {
    const content = editableContent.trim();
    if (!content) return null;
    const draftFolderPath = options.folderPath ?? editableFolder;
    setEditableStatus("saving_draft");
    setEditableError("");
    setError("");
    setNotice("");
    try {
      const result = editableDraft?.id
        ? await api.updateKnowledgeEditableCaptureDraft(editableDraft.id, {
            content,
            title: editableTitle,
            folder_path: draftFolderPath,
            existing_folders: visibleFolderPaths,
            ...(options.preserveEditableMetadata
              ? {
                  summary: editableSummary,
                  tags: parseTagsText(editableTagsText),
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
                }
              : {}),
          })
        : await api.createKnowledgeEditableCaptureDraft({
            content,
            source: editableSource,
            source_type: "manual",
            title: editableTitle,
            folder_path: draftFolderPath,
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
      await refreshAll();
      setNotice("已整理成草稿，可以入库到知识库。");
      return payload.draft;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEditableError(message);
      setEditableStatus("error");
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
      setEditableSummary("");
      setEditableTagsText("");
      setEditableSource("");
      setEditableFolder(selectedFolder || "Inbox");
      setEditableFolderSuggestionMode("existing");
      setEditableFolderSuggestionReason("");
      setEditableGenerateCard(false);
      setEditableCardReason("");
      setEditableCardSuggestionsText("");
      setEditableStatus("empty");
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
    setEditableStatus("committing");
    setEditableError("");
    setError("");
    setNotice("");
    try {
      const targetFolder = await ensureEditableFolder(editableFolder);
      if (targetFolder !== editableFolder) {
        setEditableFolder(targetFolder);
      }
      const draft = await saveEditableCaptureDraft({
        preserveEditableMetadata: true,
        folderPath: targetFolder,
      });
      if (!draft) return;
      await api.commitKnowledgeCaptureDraft(draft.id);
      const payload = await api.getKnowledgeCaptureDraft(draft.id);
      applyEditableDraftSuggestion(payload.draft, {
        fallbackContent: "",
        fallbackFolder: targetFolder,
      });
      setEditableStatus("committed");
      setSelection({ type: "folder", value: targetFolder || "Inbox" });
      setExpandedFolders((current) => new Set(current).add(targetFolder || "Inbox"));
      setSelectedKey(`capture_draft:${draft.id}`);
      await refreshAll();
      if (editableGenerateCard && payload.draft.committed_capture_id) {
        const cardHint = firstGardenCardHint(editableCardSuggestionsText);
        await api.createKnowledgeGardenDraft({
          capture_ids: [payload.draft.committed_capture_id],
          title: cardHint.title,
          card_kind: cardHint.card_kind,
          instruction: buildGardenDraftInstruction(editableCardReason, editableCardSuggestionsText),
        });
        setNotice(`已入库并生成 Garden Card：《${payload.draft.title || "未命名草稿"}》。`);
      } else {
        setNotice(`已入库到知识库：《${payload.draft.title || "未命名草稿"}》。`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEditableError(message);
      setEditableStatus("error");
    }
  }, [
    editableCardReason,
    editableCardSuggestionsText,
    editableFolder,
    editableGenerateCard,
    ensureEditableFolder,
    refreshAll,
    saveEditableCaptureDraft,
  ]);

  const askArticleAi = useCallback(async (override?: { question?: string; mode?: KnowledgeResearchMode }) => {
    if (!detail || chatLoading) return;
    const question = (override?.question ?? chatQuestion).trim();
    const requestMode = override?.mode ?? articleResearchMode;
    if (!question) return;
    const context = selectionContext;
    const assistantId = `assistant-${Date.now()}`;
    const pendingTrace = pendingResearchTrace(question, requestMode);
    const userMessage: ArticleChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question,
      selectionPreview: context?.selectedText ? context.selectedText.slice(0, 160) : "",
      createdAt: new Date().toISOString(),
    };
    const pendingMessage: ArticleChatMessage = {
      id: assistantId,
      role: "assistant",
      content: webResearchMode(requestMode) ? "正在检索公开网页并读取可用材料..." : "正在基于可用材料回答...",
      selectionPreview: context?.selectedText ? context.selectedText.slice(0, 160) : "",
      createdAt: new Date().toISOString(),
      pending: true,
      mode: requestMode,
      researchTrace: pendingTrace,
      responseMeta: {
        web_queries: webResearchMode(requestMode) ? [question] : [],
        research_trace: pendingTrace,
        web_search_attempted: webResearchMode(requestMode),
      },
      researchEvents: [
        {
          key: `request:${Date.now()}`,
          label: webResearchMode(requestMode) ? "准备联网检索" : "准备回答",
          detail: question,
          at: new Date().toISOString(),
        },
      ],
    };
    setChatMessages((messages) => [...messages, userMessage, pendingMessage]);
    setChatQuestion("");
    setChatLoading(true);
    setChatError("");
    const requestBody = {
        question,
        selected_text: context?.selectedText || "",
        surrounding_before: context?.surroundingBefore || "",
        surrounding_after: context?.surroundingAfter || "",
        heading_path: context?.headingPath || [],
        selection_start: context?.selectionStart,
        selection_end: context?.selectionEnd,
        selection_confidence: context?.selectionConfidence || "none",
        mode: requestMode,
      };
    let sawProgressEvent = false;
    const streamController = new AbortController();
    chatStreamAbortRef.current = streamController;
    try {
      const response = await api.streamSelectionChatKnowledgeLibraryItem(
        detail.kind,
        detail.id,
        requestBody,
        (event) => {
          if (event.event === "progress") {
            sawProgressEvent = true;
          }
          setChatMessages((messages) =>
            messages.map((message) =>
              message.id === assistantId ? applySelectionChatStreamEvent(message, event, requestMode) : message,
            ),
          );
        },
        streamController.signal,
      );
      const assistantMessage: ArticleChatMessage = {
        id: assistantId,
        role: "assistant",
        content: response.answer || "AI 没有返回内容。",
        selectionPreview: response.used_selection && context?.selectedText ? context.selectedText.slice(0, 160) : "",
        createdAt: new Date().toISOString(),
        mode: response.mode || requestMode,
        sources: response.sources,
        researchTrace: response.meta?.research_trace,
        responseMeta: response.meta,
        warnings: response.warnings,
      };
      setChatMessages((messages) =>
        messages.map((message) =>
          message.id === assistantId
            ? {
                ...assistantMessage,
                researchEvents: mergeResearchEvents(
                  message.researchEvents,
                  researchTimelineEventsFromTrace(response.meta?.research_trace),
                ),
              }
            : message,
        ),
      );
    } catch (err) {
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
          selectionPreview: response.used_selection && context?.selectedText ? context.selectedText.slice(0, 160) : "",
          createdAt: new Date().toISOString(),
          mode: response.mode || requestMode,
          sources: response.sources,
          researchTrace: response.meta?.research_trace,
          responseMeta: response.meta,
          warnings: [...(response.warnings || []), "实时流式连接失败，已回退到普通请求。"],
        };
        setChatMessages((messages) =>
          messages.map((message) =>
            message.id === assistantId
              ? {
                  ...assistantMessage,
                  researchEvents: mergeResearchEvents(
                    message.researchEvents,
                    researchTimelineEventsFromTrace(response.meta?.research_trace),
                  ),
                }
              : message,
          ),
        );
      } catch (fallbackErr) {
        const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        setChatError(message);
        setChatMessages((messages) =>
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
      if (chatStreamAbortRef.current === streamController) {
        chatStreamAbortRef.current = null;
      }
      setChatLoading(false);
    }
  }, [articleResearchMode, chatLoading, chatQuestion, detail, selectionContext]);

  const refreshArticleAiWithWeb = useCallback(() => {
    const lastQuestion = [...chatMessages].reverse().find((item) => item.role === "user")?.content || chatQuestion;
    if (!lastQuestion.trim()) return;
    setArticleResearchMode("local_web");
    void askArticleAi({
      question: lastQuestion,
      mode: "local_web",
    });
  }, [askArticleAi, chatMessages, chatQuestion]);

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
        instruction: outputType === "knowledge_card" ? "把知识库右侧 AI 回答做成卡片" : "把知识库右侧 AI 回答存成学习笔记",
        output_type: outputType,
        assistant_message_id: message.id,
        sources: articleSourcesForSave(message.sources, detail),
        answer_source: "provided",
      });
      const draftId =
        typeof result.meta?.reading_draft_id === "string"
          ? result.meta.reading_draft_id
          : "";
      await refreshAll();
      setNotice(result.chat_preview || (outputType === "knowledge_card" ? "已生成知识卡片草稿。" : "已生成学习笔记草稿。"));
      if (draftId) {
        navigate(`/knowledge-chat?answerDraft=${encodeURIComponent(draftId)}`);
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingArticleAnswerId("");
    }
  }, [chatMessages, chatQuestion, detail, navigate, refreshAll]);

  const canPublishDetail = detail?.kind === "capture_draft" && !committing && !saving && !deleting;
  const canGenerateCard = detail?.kind === "capture" && !cardGenerating && !saving && !deleting;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-foreground">
      <header className="flex h-[52px] shrink-0 items-center justify-between rounded-lg border border-border bg-background px-4">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-normal">知识库</h1>
        <div className="relative">
          <button
            type="button"
            onClick={() => setNewMenuOpen((open) => !open)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            新建
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {newMenuOpen ? (
            <div className="absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-md border border-border bg-background shadow-lg">
              <MenuAction description="粘贴材料，由 Hermes 生成元信息建议" icon={NotebookPen} label="粘贴整理" onClick={pasteAndOrganize} />
              <MenuAction description="从空白开始写一篇知识文件" icon={FilePlus2} label="新建空白文件" onClick={createFile} />
              <MenuAction description="导入 .txt / .md 文件内容后整理" icon={UploadCloud} label="导入 Text / Markdown 文件" onClick={importContent} />
            </div>
          ) : null}
          <input
            ref={importInputRef}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="hidden"
            onChange={(event) => void handleImportContent(event)}
          />
        </div>
      </header>

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
        className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[var(--knowledge-left-width)_8px_minmax(0,1fr)]"
      >
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
          <div className="shrink-0 border-b border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">知识库</h2>
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
	                        onClick={() => {
                            if (!confirmLeaveCurrentWork()) return;
	                          setSelectedKey(itemKey(item));
	                          setWorkbenchMode("browse");
	                          switchMode("files");
	                        }}
	                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState text="当前范围没有符合条件的文件。" />
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
                    count={viewCount(views, "recent", allItems.length)}
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
              generateCard={editableGenerateCard}
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
                }
              }}
              onFolderChange={(value) => {
                setEditableFolder(value);
                if (editableStatus !== "committed") setEditableStatus("editing");
              }}
              onFolderSuggestionModeChange={setEditableFolderSuggestionMode}
              onFolderSuggestionReasonChange={setEditableFolderSuggestionReason}
              onGenerateCardChange={setEditableGenerateCard}
              onDeleteDraft={() => void deleteEditableCaptureDraft()}
              onSaveDraft={() => void saveEditableCaptureDraft()}
              onSourceChange={setEditableSource}
              onSummaryChange={setEditableSummary}
              onTagsTextChange={setEditableTagsText}
              onTitleChange={(value) => {
                setEditableTitle(value);
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
	              detail && workbenchMode === "browse" && aiPanelMode === "collapsed"
	                ? "xl:grid-cols-[minmax(0,1fr)_44px]"
	                : detail && workbenchMode === "browse" && aiPanelOpen
	                  ? "xl:grid-cols-[minmax(0,1fr)_44px] 2xl:grid-cols-[minmax(0,1fr)_8px_var(--knowledge-ai-width)]"
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
	                  onModeChange={setWorkbenchMode}
	                  onPublish={() => void commitDraft()}
	                  onSave={() => void saveDetail()}
	                  onSelectionContextChange={setSelectionContext}
	                  onTitleChange={setDraftTitle}
	                  aiPanelOpen={aiPanelOpen}
	                />
	              ) : (
	                <EmptyState text="从左侧文件夹或文件列表选择一个文件。" />
	              )}
	            </section>
	            {detail && workbenchMode === "browse" && aiPanelOpen ? (
                  <>
                    <ResizableRail
                      className="!hidden 2xl:!flex"
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
                    panelMode={aiPanelMode}
	                researchMode={articleResearchMode}
	                question={chatQuestion}
	                savingAnswerId={savingArticleAnswerId}
	                selectionContext={selectionContext}
	                onAsk={() => void askArticleAi()}
	                onClose={() => setAiPanelMode("collapsed")}
                    onPanelModeChange={setAiPanelMode}
	                onQuestionChange={setChatQuestion}
	                onResearchModeChange={setArticleResearchMode}
	                onRefreshWeb={refreshArticleAiWithWeb}
	                onSaveAnswer={saveArticleAiAnswer}
	              />
                    <CollapsedAIPanelRail
                      className="2xl:!hidden"
                      loading={chatLoading}
                      onOpen={() => setAiPanelMode("assist")}
                    />
                  </>
	            ) : detail && workbenchMode === "browse" && aiPanelMode === "collapsed" ? (
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
  return {
    mode,
    folder_path: stringValue(suggestion.folder_path) || stringValue(intent?.folder_path),
    reason: stringValue(suggestion.reason),
  };
}

function editableCardSuggestion(intent: Record<string, unknown> | undefined): {
  should_generate: boolean;
  reason: string;
  cards: Array<{ title: string; card_kind: string; reason: string }>;
} {
  const raw = intent?.card_suggestion;
  const suggestion = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    should_generate: suggestion.should_generate === true,
    reason: stringValue(suggestion.reason),
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
    gardenDraftCount ? `${gardenDraftCount} 条 Garden 草稿` : "",
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
    "- Obsidian 源文件",
    `- Garden Card：${counts.cardCount} 张`,
    `- Garden 草稿：${counts.gardenDraftCount} 条`,
    `- 历史草稿：${counts.draftCount} 条`,
    `- 其他文件引用：${counts.backlinkCount} 个`,
    `- 运行记录：${counts.eventCount} 条`,
    "- 数据库 capture 行：保留，状态改为 archived",
  ].join("\n");
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

function MenuAction({
  description,
  icon: Icon,
  label,
  onClick,
}: {
  description?: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-foreground transition hover:bg-primary/10"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </button>
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
  onModeChange,
  onPublish,
  onSave,
  onSelectionContextChange,
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
  onModeChange: (mode: LibraryWorkbenchMode) => void;
  onPublish: () => void;
  onSave: () => void;
  onSelectionContextChange: (context: ArticleSelectionContext | null) => void;
  onTitleChange: (value: string) => void;
}) {
  const isPublished = detail.kind === "capture";
  return (
    <>
      <div className="shrink-0 border-b border-border p-4">
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
              onClick={onAiPanelToggle}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 text-xs text-muted-foreground transition hover:border-primary/35 hover:text-foreground"
              title={aiPanelOpen ? "收起 AI 面板" : "展开 AI 面板"}
            >
              {aiPanelOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
              AI
            </button>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
              title="更多"
              aria-label="更多"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
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
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {mode === "edit" ? (
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
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-border bg-background/65 px-3 py-2 text-sm">
              <span className="shrink-0 text-muted-foreground">所在文件夹</span>
              <span className="min-w-0 flex-1 truncate">{folder || "Inbox"}</span>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-md border border-border bg-background/65 px-3 py-2 text-sm text-muted-foreground">
            <span className="truncate">{detail.file_path || "入库后写入 Obsidian"}</span>
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <StatusTile
            active={Boolean(detail.file_path)}
            label="Obsidian"
            value={detail.file_path ? "已写入文件" : "入库后写入"}
          />
          <StatusTile
            active={detail.indexed}
            label="AI 检索"
            value={detail.indexed ? "可被 AI 检索" : "尚未检索"}
          />
          <StatusTile
            active={detail.garden_card_count > 0}
            label="Garden Card"
            value={detail.garden_card_count > 0 ? `${detail.garden_card_count} 张卡片` : "尚未生成"}
          />
        </div>
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

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-3">
        <div className="min-w-0 flex flex-wrap gap-1.5">
          {detail.tags.length ? detail.tags.map((tag) => <TinyPill key={tag}>{tag}</TinyPill>) : <TinyPill>暂无标签</TinyPill>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting || saving || committing || cardGenerating}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/8 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/12 disabled:opacity-45"
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            删除
          </button>
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
          {isPublished ? (
            <button
              type="button"
              onClick={onGenerateCard}
              disabled={!canGenerateCard}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 text-sm font-medium text-foreground transition hover:bg-primary/15 disabled:opacity-45"
            >
              {cardGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers3 className="h-4 w-4" />}
              生成卡片
            </button>
          ) : (
            <button
              type="button"
              onClick={onPublish}
              disabled={!canPublish}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 text-sm font-medium text-foreground transition hover:bg-primary/15 disabled:opacity-45"
            >
              {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              入库到知识库
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function ReadonlyMarkdownDocument({
  body,
  onSelectionContextChange,
}: {
  body: string;
  onSelectionContextChange: (context: ArticleSelectionContext | null) => void;
}) {
  const updateSelection = useCallback(() => {
    const selectedText = window.getSelection()?.toString().trim() ?? "";
    onSelectionContextChange(selectionContextFromSelectedText(body, selectedText));
  }, [body, onSelectionContextChange]);

  return (
    <article
      className="h-full min-h-[360px] overflow-y-auto rounded-md border border-border bg-background/70 px-5 py-4"
      onKeyUpCapture={updateSelection}
      onMouseUpCapture={updateSelection}
    >
      {body.trim() ? (
        <Markdown content={body} />
      ) : (
        <p className="text-sm text-muted-foreground">暂无正文</p>
      )}
    </article>
  );
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
  panelMode,
  researchMode,
  question,
  savingAnswerId,
  selectionContext,
  onAsk,
  onClose,
  onPanelModeChange,
  onQuestionChange,
  onResearchModeChange,
  onRefreshWeb,
  onSaveAnswer,
}: {
  chatError: string;
  detail: KnowledgeLibraryItem;
  loading: boolean;
  messages: ArticleChatMessage[];
  panelMode: ArticleAIPanelMode;
  researchMode: KnowledgeResearchMode;
  question: string;
  savingAnswerId: string;
  selectionContext: ArticleSelectionContext | null;
  onAsk: () => void;
  onClose: () => void;
  onPanelModeChange: (mode: ArticleAIPanelMode) => void;
  onQuestionChange: (value: string) => void;
  onResearchModeChange: (mode: KnowledgeResearchMode) => void;
  onRefreshWeb: () => void;
  onSaveAnswer: (message: ArticleChatMessage, outputType: "local_learning_note" | "knowledge_card") => void;
}) {
  const selectedLength = selectionContext?.selectedText.length ?? 0;
  const hasPendingAssistant = messages.some((message) => message.role === "assistant" && message.pending);
  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background 2xl:flex">
      <div className="shrink-0 border-b border-border p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">AI 对话</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">当前文件：{detail.title || "未命名文件"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onPanelModeChange(panelMode === "focus" ? "assist" : "focus")}
              className="rounded p-1 text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
              title={panelMode === "focus" ? "恢复默认宽度" : "放大 AI 面板"}
              aria-label={panelMode === "focus" ? "恢复默认宽度" : "放大 AI 面板"}
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
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
        <div className="mt-3 rounded-md border border-border bg-background/65 px-3 py-2 text-xs text-muted-foreground">
          {selectedLength ? `已选中 ${selectedLength} 字` : "未选择文本，将基于当前文章提问"}
          {selectionContext?.headingPath.length ? (
            <div className="mt-1 truncate">位置：{selectionContext.headingPath.join(" / ")}</div>
          ) : null}
        </div>
        <ResearchModeControl
          disabled={loading}
          mode={researchMode}
          onChange={onResearchModeChange}
        />
        <button
          type="button"
          onClick={onRefreshWeb}
          disabled={loading || !messages.some((message) => message.role === "user") && !question.trim()}
          className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background/65 px-2 text-xs text-muted-foreground transition hover:border-primary/35 hover:text-foreground disabled:opacity-45"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          重新联网检索
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {messages.length ? (
          <div className="space-y-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm leading-6",
                  message.role === "user"
                    ? "border-primary/25 bg-primary/8"
                    : "border-border bg-background/65",
                )}
              >
                {message.selectionPreview ? (
                  <div className="mb-1 rounded border border-border bg-background/60 px-2 py-1 text-xs text-muted-foreground">
                    选区：{message.selectionPreview}
                  </div>
                ) : null}
                {message.role === "assistant" ? (
                  <ArticleAssistantAnswer
                    content={message.content}
                    message={message}
                    saving={savingAnswerId === message.id}
                    onSave={onSaveAnswer}
                  />
                ) : (
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                )}
              </div>
            ))}
            {loading && !hasPendingAssistant ? (
              <LoadingState
                text={researchMode === "local_web" || researchMode === "web_only"
                  ? "正在搜索并读取网页..."
                  : "AI 正在回答..."}
              />
            ) : null}
          </div>
        ) : (
          <EmptyState text="选中文章中的一段话，或直接输入问题。" />
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
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onAsk();
            }
          }}
          className="h-24 w-full resize-none rounded-md border border-border bg-background/70 px-3 py-2 text-sm leading-6 outline-none focus:border-primary/40"
          placeholder="问 AI..."
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onAsk}
            disabled={loading || !question.trim()}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-45"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            发送
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
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "hidden min-h-0 flex-col items-center justify-start gap-2 rounded-lg border border-border bg-background px-2 py-3 text-muted-foreground transition hover:border-primary/35 hover:text-foreground xl:flex",
        className,
      )}
      title="展开 AI 面板"
      aria-label="展开 AI 面板"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <PanelRightOpen className="h-4 w-4" />}
      <span className="writing-mode-vertical text-xs font-medium [writing-mode:vertical-rl]">AI</span>
    </button>
  );
}

const ARTICLE_RESEARCH_MODES: Array<{ label: string; mode: KnowledgeResearchMode }> = [
  { label: "当前文章", mode: "current_article_only" },
  { label: "仅知识库", mode: "local_only" },
  { label: "知识库+联网搜索", mode: "local_web" },
  { label: "联网搜索", mode: "web_only" },
];

function ResearchModeControl({
  disabled,
  mode,
  onChange,
}: {
  disabled: boolean;
  mode: KnowledgeResearchMode;
  onChange: (mode: KnowledgeResearchMode) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-1 rounded-md border border-border bg-background/70 p-1">
      {ARTICLE_RESEARCH_MODES.map((item) => (
        <button
          key={item.mode}
          type="button"
          disabled={disabled}
          onClick={() => onChange(item.mode)}
          className={cn(
            "rounded px-2 py-1 text-xs font-medium transition",
            mode === item.mode
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-background/90 hover:text-foreground",
            disabled && "opacity-45",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function webResearchMode(mode: KnowledgeResearchMode | undefined): boolean {
  return mode === "local_web" || mode === "web_only";
}

function pendingResearchTrace(question: string, mode: KnowledgeResearchMode): KnowledgeResearchTrace {
  const usesWeb = webResearchMode(mode);
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

  if (event.event === "start") {
    return {
      ...message,
      researchEvents: mergeResearchEvents(message.researchEvents, [researchTimelineEventFromStream(event, trace, mode)].filter(isTimelineEvent)),
    };
  }

  switch (event.type) {
    case "planning_start":
      providerStatus.stage = "正在规划检索";
      content = webResearchMode(mode) ? "正在规划联网检索..." : "正在规划回答路径...";
      break;
    case "plan":
      trace.plan_status = event.plan_status || trace.plan_status;
      trace.web_search_attempted = Boolean(event.needs_web);
      trace.web_queries = event.queries || trace.web_queries || [];
      trace.query_intent = event.intent_label || trace.query_intent;
      providerStatus.stage = event.needs_web ? "已规划联网查询" : "已规划本地回答";
      content = event.needs_web ? "已规划联网查询，准备检索公开网页..." : "已规划回答路径，准备检索本地材料...";
      break;
    case "local_search_start":
      providerStatus.stage = "正在检索本地知识库";
      content = "正在检索本地知识库...";
      break;
    case "local_search_done":
      trace.knowledge_sources = mergeResearchSources(trace.knowledge_sources, event.knowledge_sources);
      providerStatus.stage = "本地知识库检索完成";
      content = "本地知识库检索完成，继续整理证据...";
      break;
    case "web_search_start":
      trace.web_search_attempted = true;
      trace.web_queries = event.queries || trace.web_queries || [];
      providerStatus.stage = "正在发起联网搜索";
      content = "正在发起联网搜索...";
      break;
    case "web_query_start":
      trace.web_search_attempted = true;
      providerStatus.stage = event.query ? `正在搜索：${event.query}` : "正在搜索网页";
      content = event.query ? `正在搜索：${event.query}` : "正在搜索网页...";
      break;
    case "web_query_done":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      providerStatus.stage = event.query ? `已完成搜索：${event.query}` : "网页搜索完成";
      content = `已找到 ${event.result_count ?? event.web_sources?.length ?? 0} 个候选网页，正在筛选来源...`;
      break;
    case "web_query_error":
      providerStatus.stage = event.error || "部分搜索失败";
      warnings = uniqueStrings([...warnings, event.error || "部分搜索失败"]);
      content = "部分搜索失败，正在使用可用结果继续...";
      break;
    case "web_ranked":
      trace.search_quality = event.search_quality || trace.search_quality;
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      trace.rewritten_web_queries = event.rewritten_queries || trace.rewritten_web_queries || [];
      providerStatus.stage = "已筛选候选来源";
      content = "已筛选候选来源，准备整理网页资料...";
      break;
    case "web_classified":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.candidate_sources);
      trace.clue_sources = mergeResearchSources(trace.clue_sources, event.clue_sources);
      trace.rejected_sources = mergeResearchSources(trace.rejected_sources, event.rejected_sources);
      providerStatus.stage = "已完成来源分层";
      content = "已区分采用依据、线索来源和未采用来源...";
      break;
    case "web_rewrite_start":
      trace.rewritten_web_queries = event.queries || trace.rewritten_web_queries || [];
      providerStatus.stage = "正在改写搜索词";
      content = "搜索结果质量不足，正在改写搜索词...";
      break;
    case "web_fallback_start":
      providerStatus.stage = event.backend ? `正在补充搜索：${event.backend}` : "正在补充搜索";
      providerStatus.fallback_reason = event.reason || providerStatus.fallback_reason;
      content = event.backend ? `正在通过 ${event.backend} 补充搜索...` : "正在补充搜索...";
      break;
    case "web_fallback_done":
      trace.search_quality = event.search_quality || trace.search_quality;
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      providerStatus.stage = event.backend ? `补充搜索完成：${event.backend}` : "补充搜索完成";
      providerStatus.fallback_last = event.backend || providerStatus.fallback_last;
      content = `补充搜索找到 ${event.result_count ?? event.web_sources?.length ?? 0} 个候选网页，继续筛选...`;
      break;
    case "web_extract_start":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      providerStatus.stage = "正在整理网页资料";
      content = "正在整理网页来源和可用摘要...";
      break;
    case "web_extract_done":
      trace.provider_status = event.provider_status || trace.provider_status;
      trace.web_sources = mergeResearchSources(trace.web_sources, event.web_sources);
      trace.evidence_sources = mergeResearchSources(trace.evidence_sources, event.evidence_sources || event.web_sources);
      providerStatus.stage = "网页资料整理完成";
      content = "网页资料整理完成，正在组织回答...";
      break;
    case "web_critic_start":
      trace.candidate_sources = mergeResearchSources(trace.candidate_sources, event.web_sources);
      providerStatus.stage = "正在核验证据是否支撑回答";
      content = "正在核验证据是否支撑回答...";
      break;
    case "web_critic_done":
      trace.web_sources = mergeResearchSources(trace.web_sources, event.web_sources);
      trace.evidence_sources = mergeResearchSources(trace.evidence_sources, event.evidence_sources || event.web_sources);
      trace.rejected_sources = mergeResearchSources(trace.rejected_sources, event.rejected_sources);
      providerStatus.stage = "证据核验完成";
      content = "证据核验完成，正在组织回答...";
      break;
    case "synthesis_start":
      providerStatus.stage = "正在生成答案";
      content = "正在基于可验证来源整理答案...";
      break;
    case "warnings":
      warnings = uniqueStrings([...warnings, ...(event.warnings || [])]);
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
    researchEvents: mergeResearchEvents(message.researchEvents, [researchTimelineEventFromStream(event, trace, mode)].filter(isTimelineEvent)),
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

function isTimelineEvent(event: ResearchTimelineEvent | null): event is ResearchTimelineEvent {
  return Boolean(event);
}

function mergeResearchEvents(
  current: ResearchTimelineEvent[] | undefined,
  incoming: ResearchTimelineEvent[] | undefined,
): ResearchTimelineEvent[] {
  const merged = new Map<string, ResearchTimelineEvent>();
  for (const event of [...(current || []), ...(incoming || [])]) {
    merged.set(event.key, { ...merged.get(event.key), ...event });
  }
  return Array.from(merged.values()).slice(-40);
}

function researchTimelineEventFromStream(
  event: KnowledgeLibrarySelectionChatStreamEvent,
  trace: KnowledgeResearchTrace,
  mode: KnowledgeResearchMode,
): ResearchTimelineEvent | null {
  const at = new Date().toISOString();
  const type = event.type || event.event;
  const query = event.query || "";
  const backend = event.backend || "";
  const key = [
    type,
    query,
    backend,
    event.result_count ?? "",
    event.new_result_count ?? "",
    event.web_sources?.length ?? "",
    event.candidate_sources?.length ?? "",
    event.clue_sources?.length ?? "",
    event.rejected_sources?.length ?? "",
  ].join(":");
  const sourceCount = event.result_count ?? event.web_sources?.length ?? event.candidate_sources?.length ?? event.evidence_sources?.length ?? 0;
  const sourceDetail = sourceSummary(event.web_sources || event.evidence_sources || event.candidate_sources || []);

  switch (event.event === "start" ? "stream_start" : event.type) {
    case "stream_start":
      return {
        key,
        label: "已连接实时检索",
        detail: researchModeLabel(mode),
        at,
      };
    case "planning_start":
      return {
        key,
        label: "开始规划",
        detail: webResearchMode(mode) ? "准备生成联网查询" : "准备判断回答路径",
        at,
      };
    case "plan":
      return {
        key,
        label: event.needs_web ? "规划联网查询" : "规划本地回答",
        detail: uniqueStrings(event.queries || []).join(" / ") || event.intent_label || researchStatusLabel(trace.plan_status as string),
        at,
      };
    case "local_search_start":
      return { key, label: "检索本地知识库", at };
    case "local_search_done":
      return {
        key,
        label: "本地检索完成",
        detail: `${event.knowledge_sources?.length ?? 0} 条本地材料`,
        at,
        tone: "success",
      };
    case "web_search_start":
      return {
        key,
        label: "发起联网搜索",
        detail: uniqueStrings(event.queries || []).join(" / "),
        at,
      };
    case "web_query_start":
      return { key, label: "搜索网页", detail: query, at };
    case "web_query_done":
      return {
        key,
        label: "发现候选网页",
        detail: `${sourceCount} 个结果${sourceDetail ? ` · ${sourceDetail}` : ""}`,
        at,
        tone: "success",
      };
    case "web_query_error":
      return { key, label: "搜索异常", detail: event.error || "部分搜索失败", at, tone: "warning" };
    case "web_ranked":
      return {
        key,
        label: "筛选候选来源",
        detail: `${sourceCount} 个候选${sourceDetail ? ` · ${sourceDetail}` : ""}`,
        at,
      };
    case "web_classified":
      return {
        key,
        label: "完成来源分层",
        detail: `候选 ${event.candidate_sources?.length ?? 0} / 线索 ${event.clue_sources?.length ?? 0} / 未采用 ${
          event.rejected_sources?.length ?? 0
        }`,
        at,
      };
    case "web_rewrite_start":
      return { key, label: "改写查询词", detail: uniqueStrings(event.queries || []).join(" / "), at, tone: "warning" };
    case "web_fallback_start":
      return {
        key,
        label: "补充检索",
        detail: [backend, event.reason].filter(Boolean).join(" · "),
        at,
        tone: "warning",
      };
    case "web_fallback_done":
      return {
        key,
        label: "补充检索完成",
        detail: `${event.result_count ?? 0} 个结果，新增 ${event.new_result_count ?? 0} 个`,
        at,
        tone: "success",
      };
    case "web_extract_start":
      return {
        key,
        label: "读取网页正文",
        detail: sourceDetail || `${sourceCount} 个网页`,
        at,
      };
    case "web_extract_done":
      return {
        key,
        label: "网页资料整理完成",
        detail: `${sourceCount} 个可用来源${sourceDetail ? ` · ${sourceDetail}` : ""}`,
        at,
        tone: "success",
      };
    case "web_critic_start":
      return {
        key,
        label: "核验证据",
        detail: sourceDetail || "检查来源是否支撑回答",
        at,
      };
    case "web_critic_done":
      return {
        key,
        label: "证据核验完成",
        detail: `采用 ${event.web_sources?.length ?? event.evidence_sources?.length ?? 0} / 未采用 ${event.rejected_sources?.length ?? 0}`,
        at,
        tone: event.rejected_sources?.length ? "warning" : "success",
      };
    case "synthesis_start":
      return { key, label: "生成答案", detail: "基于采用来源组织回答", at };
    case "warnings":
      return { key, label: "记录警告", detail: uniqueStrings(event.warnings || []).join("；"), at, tone: "warning" };
    default:
      if (event.event === "complete") return { key, label: "生成完成", at, tone: "success" };
      if (event.event === "error") return { key, label: "生成失败", detail: event.message || event.error, at, tone: "error" };
      return null;
  }
}

function researchTimelineEventsFromTrace(trace: KnowledgeResearchTrace | undefined): ResearchTimelineEvent[] {
  const events = trace?.event_log;
  if (!Array.isArray(events)) return [];
  return events
    .map((event, index): ResearchTimelineEvent | null => {
      if (!event || typeof event !== "object") return null;
      const record = event as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label : typeof record.type === "string" ? record.type : "";
      if (!label) return null;
      return {
        key: typeof record.key === "string" ? record.key : `trace:${index}:${label}`,
        label,
        detail: typeof record.detail === "string" ? record.detail : undefined,
        at: typeof record.at === "string" ? record.at : new Date().toISOString(),
      };
    })
    .filter(isTimelineEvent);
}

function sourceSummary(sources: KnowledgeResearchSource[]): string {
  return uniqueStrings(
    sources
      .slice(0, 3)
      .map((source) => source.domain || (source.url ? hostLabel(source.url) : "") || source.title || "")
      .filter(Boolean),
  ).join("、");
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
  return Array.from(merged.values()).slice(0, 5);
}

function ArticleAssistantAnswer({
  content,
  message,
  saving,
  onSave,
}: {
  content: string;
  message: ArticleChatMessage;
  saving: boolean;
  onSave: (message: ArticleChatMessage, outputType: "local_learning_note" | "knowledge_card") => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyAnswer = useCallback(async () => {
    if (!content.trim()) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [content]);

  return (
    <div className="min-w-0">
      {!message.pending ? (
        <div className="mb-2 flex flex-wrap justify-end gap-1">
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
            onClick={() => onSave(message, "local_learning_note")}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-45"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <NotebookPen className="h-3.5 w-3.5" />}
            存笔记
          </button>
          <button
            type="button"
            onClick={() => onSave(message, "knowledge_card")}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-45"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers3 className="h-3.5 w-3.5" />}
            做卡片
          </button>
        </div>
      ) : null}
      <div className="[&_a]:break-words [&_pre]:max-w-full">
        <ArticleResearchProcess message={message} />
        {message.pending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {content}
          </div>
        ) : (
          <Markdown content={stripTrailingReferenceSection(content)} />
        )}
      </div>
      {!message.pending ? <ArticleSourceList content={content} sources={message.sources} warnings={message.warnings} /> : null}
    </div>
  );
}

const ArticleResearchProcess = memo(function ArticleResearchProcess({ message }: { message: ArticleChatMessage }) {
  const trace = message.researchTrace;
  const meta = message.responseMeta;
  const webQueries = uniqueStrings([
    ...stringArray(trace?.rewritten_web_queries),
    ...stringArray(trace?.rewritten_queries),
    ...stringArray(trace?.web_queries),
    ...stringArray(trace?.queries),
    ...stringArray(meta?.rewritten_web_queries),
    ...stringArray(meta?.web_queries),
  ]);
  const providerStatus = providerStatusLabels(trace?.provider_status ?? meta?.provider_status);
  const currentStage =
    typeof trace?.provider_status === "object" && trace.provider_status && "stage" in trace.provider_status
      ? String((trace.provider_status as Record<string, unknown>).stage || "")
      : "";
  const status = typeof trace?.plan_status === "string" ? trace.plan_status : "";
  const evidenceStatus =
    typeof trace?.evidence_status === "string"
      ? trace.evidence_status
      : typeof trace?.search_quality?.evidence_status === "string"
        ? trace.search_quality.evidence_status
        : "";
  const answerDepth = typeof trace?.answer_depth === "string" ? trace.answer_depth : "";
  const webSearchAttempted = Boolean(trace?.web_search_attempted ?? meta?.web_search_attempted);
  const webStatus = message.pending && webResearchMode(message.mode) ? "准备中" : webSearchAttempted ? "已发起" : "未发起";
  const knowledgeCount = message.sources?.knowledge?.length ?? traceSourceCount(trace?.knowledge_sources);
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
  const primaryEvidenceSources = evidenceSources.filter((source) => source.evidence_role === "primary_evidence");
  const supportingEvidenceSources = evidenceSources.filter((source) => source.evidence_role === "supporting_evidence");
  const interpretiveEvidenceSources = evidenceSources.filter((source) => source.evidence_role === "interpretive_evidence");
  const otherEvidenceSources = evidenceSources.filter(
    (source) => !["primary_evidence", "supporting_evidence", "interpretive_evidence"].includes(source.evidence_role || ""),
  );
  const hasSemanticEvidenceGroups = Boolean(primaryEvidenceSources.length || supportingEvidenceSources.length || interpretiveEvidenceSources.length);
  const candidateCount = trace?.source_counts?.candidate ?? candidateSources.length;
  const clueCount = trace?.source_counts?.clue ?? clueSources.length;
  const rejectedCount = trace?.source_counts?.rejected ?? rejectedSources.length;
  const independentDomains =
    trace?.source_counts?.adopted_independent_domains
      ?? countIndependentDomains(evidenceSources);
  const timelineEvents = mergeResearchEvents(message.researchEvents, researchTimelineEventsFromTrace(trace));
  const shouldRender = Boolean(
    message.mode ||
      status ||
      webQueries.length ||
      providerStatus.length ||
      webSearchAttempted ||
      knowledgeCount ||
      webCount ||
      candidateSources.length ||
      clueSources.length ||
      rejectedSources.length ||
      timelineEvents.length ||
      message.warnings?.length,
  );
  if (!shouldRender) return null;

  return (
    <div className="mb-3 rounded-md border border-border bg-background px-2.5 py-2 text-xs text-muted-foreground">
      <ResearchProgress
        currentStage={currentStage}
        mode={message.mode}
        pending={Boolean(message.pending)}
        status={status}
        webStatus={webStatus}
      />
      <ResearchTimeline events={timelineEvents} pending={Boolean(message.pending)} />
      <EvidenceSummary
        candidateCount={candidateCount}
        clueCount={clueCount}
        evidenceStatus={evidenceStatus}
        independentDomains={independentDomains}
        knowledgeCount={knowledgeCount}
        rejectedCount={rejectedCount}
        webCount={webCount}
        answerDepth={answerDepth}
      />
      {hasSemanticEvidenceGroups ? (
        <>
          <ResearchSourceGroup title="强证据" sources={primaryEvidenceSources} />
          <ResearchSourceGroup title="辅助证据" sources={supportingEvidenceSources} />
          <ResearchSourceGroup title="解释材料" sources={interpretiveEvidenceSources} />
          <ResearchSourceGroup title="采用依据" sources={otherEvidenceSources} />
        </>
      ) : (
        <ResearchSourceGroup title="采用依据" sources={evidenceSources} />
      )}
      <ResearchAuditDetails
        candidateSources={candidateSources}
        clueSources={clueSources}
        providerStatus={providerStatus}
        queries={webQueries}
        rejectedSources={rejectedSources}
        warnings={message.warnings || []}
      />
    </div>
  );
});

function ResearchTimeline({
  events,
  pending,
}: {
  events: ResearchTimelineEvent[];
  pending: boolean;
}) {
  if (!events.length) return null;
  return (
    <div
      aria-live={pending ? "polite" : "off"}
      className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded border border-border/70 bg-background/60 px-2 py-1.5"
    >
      {events.slice(-12).map((event, index) => (
        <div key={`${event.key}-${index}`} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-1.5">
          <span
            className={cn(
              "mt-1 h-1.5 w-1.5 rounded-full",
              event.tone === "error"
                ? "bg-destructive"
                : event.tone === "warning"
                  ? "bg-warning"
                  : event.tone === "success"
                    ? "bg-primary"
                    : "bg-muted-foreground/55",
            )}
          />
          <div className="min-w-0">
            <div className="truncate text-[0.72rem] font-medium text-foreground">{event.label}</div>
            {event.detail ? <div className="truncate text-[0.68rem] text-muted-foreground">{event.detail}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResearchProgress({
  currentStage,
  mode,
  pending,
  status,
  webStatus,
}: {
  currentStage: string;
  mode?: KnowledgeResearchMode;
  pending: boolean;
  status: string;
  webStatus: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : <Search className="h-3.5 w-3.5" />}
          检索过程
        </div>
        <div className="truncate text-[0.68rem] text-muted-foreground">
          {mode ? researchModeLabel(mode) : ""}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-5 overflow-hidden rounded border border-border bg-background/70 text-center text-[0.68rem]">
        {["规划", "本地", "搜网页", "筛来源", "生成"].map((stage) => (
          <span key={stage} className="border-r border-border/70 px-1 py-1 last:border-r-0">
            {stage}
          </span>
        ))}
      </div>
      <div className="mt-1.5 truncate text-[0.72rem] text-muted-foreground">
        {currentStage || researchStatusLabel(status) || webStatus}
      </div>
    </div>
  );
}

function EvidenceSummary({
  candidateCount,
  clueCount,
  evidenceStatus,
  independentDomains,
  knowledgeCount,
  rejectedCount,
  webCount,
  answerDepth,
}: {
  answerDepth: string;
  candidateCount: number;
  clueCount: number;
  evidenceStatus: string;
  independentDomains: number;
  knowledgeCount: number;
  rejectedCount: number;
  webCount: number;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 rounded border border-border/70 bg-background/60 px-2 py-1.5">
      <span>本地 {knowledgeCount}</span>
      <span className="text-foreground">采用 {webCount}</span>
      <span>独立来源 {independentDomains}</span>
      <span>候选 {candidateCount}</span>
      <span>线索 {clueCount}</span>
      <span>未采用 {rejectedCount}</span>
      {evidenceStatus ? (
        <span className="text-foreground">证据{researchEvidenceStatusLabel(evidenceStatus)}</span>
      ) : null}
      {answerDepth ? <span>深度 {researchAnswerDepthLabel(answerDepth)}</span> : null}
    </div>
  );
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
  providerStatus,
  queries,
  rejectedSources,
  warnings,
}: {
  candidateSources: KnowledgeResearchSource[];
  clueSources: KnowledgeResearchSource[];
  providerStatus: string[];
  queries: string[];
  rejectedSources: KnowledgeResearchSource[];
  warnings: string[];
}) {
  const hasDetails = queries.length || candidateSources.length || clueSources.length || rejectedSources.length || providerStatus.length || warnings.length;
  if (!hasDetails) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">展开检索细节</summary>
      <div className="mt-2">
        {queries.length ? (
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
        <ResearchSourceGroup title="已发现网页" sources={candidateSources} />
        <ResearchSourceGroup title="线索来源" sources={clueSources} showReason />
        <ResearchSourceGroup title="未采用" sources={rejectedSources} showReason />
        {providerStatus.length ? (
          <div className="mt-2 space-y-1">
            <div className="font-medium text-foreground">搜索状态</div>
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

function ArticleSourceList({
  content,
  sources,
  warnings,
}: {
  content: string;
  sources?: {
    knowledge?: KnowledgeResearchSource[];
    web?: KnowledgeResearchSource[];
  };
  warnings?: string[];
}) {
  const citedRefs = sourceRefsFromContent(content);
  const knowledge = (sources?.knowledge ?? []).filter((source) => citedRefs.has((source.ref || "").toUpperCase()));
  const web = (sources?.web ?? []).filter((source) => citedRefs.has((source.ref || "").toUpperCase()));
  if (!knowledge.length && !web.length && !warnings?.length) return null;
  return (
    <div className="mt-3 rounded-md border border-border bg-background/60 px-2 py-2 text-xs text-muted-foreground">
      {knowledge.length || web.length ? (
        <div className="font-medium text-foreground">参考来源</div>
      ) : null}
      {knowledge.length ? (
        <div className="mt-1">
          <div className="font-medium text-foreground">本地知识库</div>
          <ul className="mt-1 space-y-1">
            {knowledge.map((source, index) => (
              <li key={`${source.ref || index}-${source.id || source.title}`}>
                [{source.ref || `K${index + 1}`}] {source.title || source.id || "未命名来源"}
                {source.section ? ` / ${source.section}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {web.length ? (
        <div className={knowledge.length ? "mt-2" : ""}>
          <div className="font-medium text-foreground">联网资料</div>
          <ul className="mt-1 space-y-1">
            {web.map((source, index) => (
              <li key={`${source.ref || index}-${source.url || source.title}`} className="break-words">
                [{source.ref || `W${index + 1}`}] {source.title || source.url || "未命名网页"}
                {source.url ? ` ${source.url}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings?.length ? (
        <div className="mt-2 space-y-1 text-warning">
          {warnings.map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      ) : null}
    </div>
  );
}

function sourceRefsFromContent(content: string): Set<string> {
  return new Set(
    Array.from(content.matchAll(/\[([KW]\d+)\]/gi)).map((match) => match[1].toUpperCase()),
  );
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function traceSourceCount(sources: unknown): number {
  return Array.isArray(sources) ? sources.length : 0;
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

function countIndependentDomains(sources: KnowledgeResearchSource[]): number {
  const domains = new Set<string>();
  for (const source of sources) {
    const domain = source.domain || (source.url ? hostLabel(source.url) : "");
    if (domain) domains.add(domain);
  }
  return domains.size;
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

function researchAnswerDepthLabel(depth: string): string {
  switch (depth) {
    case "brief":
      return "简洁";
    case "normal":
      return "标准";
    case "detailed":
      return "详细";
    default:
      return depth;
  }
}

function researchModeLabel(mode: KnowledgeResearchMode): string {
  switch (mode) {
    case "current_article_only":
      return "当前文章";
    case "local_only":
      return "仅知识库";
    case "local_web":
      return "知识库+联网";
    case "web_only":
      return "联网";
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

function researchEvidenceStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    sufficient: "充分",
    limited: "有限",
    insufficient: "不足",
  };
  return labels[status] ?? status;
}

function providerStatusLabels(status: Record<string, unknown> | undefined): string[] {
  if (!status) return [];
  const preferred = [
    "search_backend",
    "extract_backend",
    "search_elapsed_ms",
    "extracted_pages",
    "summary_only_pages",
    "fallback_attempts",
    "retrieval_health",
    "warnings",
  ];
  const entries = preferred
    .filter((name) => name in status)
    .map((name) => [name, status[name]] as [string, unknown]);
  return entries
    .slice(0, 8)
    .map(([name, value]) => `${name}: ${providerStatusValue(value)}`);
}

function providerStatusValue(value: unknown): string {
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

function stripTrailingReferenceSection(content: string): string {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => /^#{0,6}\s*(参考来源|来源)\s*[:：]?\s*$/.test(line.trim()));
  if (index < 0) return content;
  return lines.slice(0, index).join("\n").trimEnd();
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

function StatusTile({
  active,
  label,
  value,
}: {
  active: boolean;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/65 px-3 py-2">
      {active ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
      ) : (
        <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="truncate text-[0.68rem] text-muted-foreground">{value}</div>
      </div>
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

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-[220px] items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
