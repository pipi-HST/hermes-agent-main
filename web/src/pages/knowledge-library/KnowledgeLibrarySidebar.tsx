import { memo, type ComponentType, type ReactNode, type RefObject } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  Layers3,
  Loader2,
  PanelLeftClose,
  Pencil,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";
import type {
  KnowledgeLibraryFolder,
  KnowledgeLibraryItem,
  KnowledgeLibrarySmartView,
} from "@/lib/api";
import { ResizableRail } from "@/components/ResizableRail";
import { cn } from "@/lib/utils";
import {
  DEFAULT_KNOWLEDGE_LEFT_WIDTH,
  KNOWLEDGE_LEFT_WIDTH_KEY,
  STATUS_FILTERS,
  type LibrarySelection,
  type StatusFilter,
  formatIso,
  itemKey,
} from "@/pages/knowledge-library/model";
import {
  EmptyState,
  LoadingState,
  StatusBadge,
  TinyPill,
} from "@/pages/knowledge-library/shared";

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
  libraryLayoutRef: RefObject<HTMLDivElement | null>;
  setLeftPaneWidth: (width: number) => void;
}

export function KnowledgeLibrarySidebar({
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
                  <Metric label="已保存" value={stats.inLibrary} />
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


function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background/60 px-2 py-1.5">
      <div className="text-[0.65rem] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

