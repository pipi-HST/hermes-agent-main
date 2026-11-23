import type { ChangeEvent, ComponentType, RefObject } from "react";
import {
  ChevronDown,
  Eye,
  Maximize2,
  Minimize2,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  UploadCloud,
} from "lucide-react";
import type { KnowledgeLibraryItem } from "@/lib/api";
import { cn } from "@/lib/utils";

interface HeaderMenuButtonProps {
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}

function HeaderMenuButton({ disabled = false, icon: Icon, label, onClick }: HeaderMenuButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition disabled:opacity-45",
        "text-foreground hover:bg-muted/70",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}

interface HeaderMenuActionProps {
  description?: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}

function HeaderMenuAction({ description, icon: Icon, label, onClick }: HeaderMenuActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-foreground transition hover:bg-muted/70"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {description ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{description}</span> : null}
      </span>
    </button>
  );
}

export interface KnowledgeLibraryHeaderProps {
  detail: KnowledgeLibraryItem | null;
  sidebarCollapsed: boolean;
  leftPaneCollapsed: boolean;
  aiPanelOpen: boolean;
  allSidebarsCollapsed: boolean;
  canEnterReadingFullscreen: boolean;
  viewMenuOpen: boolean;
  newMenuOpen: boolean;
  importInputRef: RefObject<HTMLInputElement | null>;
  onToggleViewMenu: () => void;
  onToggleNewMenu: () => void;
  onToggleWorkspaceNavigation: () => void;
  onToggleKnowledgeLeftPane: () => void;
  onToggleArticleAiPanel: () => void;
  onToggleAllSidebars: () => void;
  onEnterReadingFullscreen: () => void;
  onCreateKnowledgeFile: () => void;
  onImportContent: () => void;
  onHandleImportContent: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function KnowledgeLibraryHeader({
  detail,
  sidebarCollapsed,
  leftPaneCollapsed,
  aiPanelOpen,
  allSidebarsCollapsed,
  canEnterReadingFullscreen,
  viewMenuOpen,
  newMenuOpen,
  importInputRef,
  onToggleViewMenu,
  onToggleNewMenu,
  onToggleWorkspaceNavigation,
  onToggleKnowledgeLeftPane,
  onToggleArticleAiPanel,
  onToggleAllSidebars,
  onEnterReadingFullscreen,
  onCreateKnowledgeFile,
  onImportContent,
  onHandleImportContent,
}: KnowledgeLibraryHeaderProps) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 pb-3.5">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-foreground">
          资料伴读
        </h1>
        {detail?.folder_path ? (
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {detail.folder_path}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={onToggleViewMenu}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/80 bg-white px-3 text-xs text-muted-foreground transition hover:border-foreground/25 hover:text-foreground dark:bg-card"
            aria-expanded={viewMenuOpen}
            aria-label="视图"
            title="视图"
          >
            <Eye className="h-3.5 w-3.5" />
            视图
            <ChevronDown className="h-3 w-3" />
          </button>
          {viewMenuOpen ? (
            <div className="absolute right-0 z-20 mt-1.5 w-52 overflow-hidden rounded-xl border border-black/[0.08] bg-white p-1 shadow-lg dark:border-border dark:bg-popover">
              <HeaderMenuButton
                icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
                label={sidebarCollapsed ? "展开导航" : "收起导航"}
                onClick={onToggleWorkspaceNavigation}
              />
              <HeaderMenuButton
                icon={leftPaneCollapsed ? PanelLeftOpen : PanelLeftClose}
                label={leftPaneCollapsed ? "展开文件栏" : "收起文件栏"}
                onClick={onToggleKnowledgeLeftPane}
              />
              <HeaderMenuButton
                icon={aiPanelOpen ? PanelRightClose : PanelRightOpen}
                label={aiPanelOpen ? "收起伴读" : "展开伴读"}
                onClick={onToggleArticleAiPanel}
              />
              <HeaderMenuButton
                icon={allSidebarsCollapsed ? PanelLeftOpen : Minimize2}
                label={allSidebarsCollapsed ? "展开侧栏" : "收起全部侧栏"}
                onClick={onToggleAllSidebars}
              />
              <HeaderMenuButton
                disabled={!canEnterReadingFullscreen}
                icon={Maximize2}
                label="进入沉浸阅读"
                onClick={onEnterReadingFullscreen}
              />
            </div>
          ) : null}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={onToggleNewMenu}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            新建
            <ChevronDown className="h-3 w-3" />
          </button>
          {newMenuOpen ? (
            <div className="absolute right-0 z-20 mt-1.5 w-60 overflow-hidden rounded-xl border border-black/[0.08] bg-white p-1 shadow-lg dark:border-border dark:bg-popover">
              <HeaderMenuAction
                description="空白写作或粘贴材料后整理"
                icon={NotebookPen}
                label="新建知识文件"
                onClick={onCreateKnowledgeFile}
              />
              <HeaderMenuAction
                description="导入 .txt / .md 文件内容"
                icon={UploadCloud}
                label="导入 Text / Markdown 文件"
                onClick={onImportContent}
              />
            </div>
          ) : null}
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={onHandleImportContent}
        />
      </div>
    </header>
  );
}
