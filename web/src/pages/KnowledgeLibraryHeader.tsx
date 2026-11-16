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
        "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition disabled:opacity-45",
        "text-foreground hover:bg-background/80",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
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
    <header className="flex min-h-[52px] shrink-0 items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-1.5">
      <div className="min-w-0">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-normal">📄 资料伴读</h1>
        <p className="mt-0.5 hidden truncate text-[11px] leading-4 text-muted-foreground sm:block">
          左栏选资料/专题 → 中栏沉浸阅读与划词 → 右栏 AI 伴读解惑并一键提炼卡片
        </p>
        {detail?.folder_path ? (
          <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
            🧭 专题：{detail.folder_path}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={onToggleViewMenu}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background/65 px-3 text-sm text-muted-foreground transition hover:border-primary/35 hover:text-foreground"
            aria-expanded={viewMenuOpen}
            aria-label="视图"
            title="视图"
          >
            <Eye className="h-4 w-4" />
            视图
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {viewMenuOpen ? (
            <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-md border border-border bg-background p-1 shadow-lg">
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
                label={aiPanelOpen ? "收起 AI" : "展开 AI"}
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
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            新建
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {newMenuOpen ? (
            <div className="absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-md border border-border bg-background shadow-lg">
              <HeaderMenuAction
                description="空白写作或粘贴材料，再按需生成 AI 建议"
                icon={NotebookPen}
                label="新建知识文件"
                onClick={onCreateKnowledgeFile}
              />
              <HeaderMenuAction
                description="导入 .txt / .md 文件内容后整理"
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
