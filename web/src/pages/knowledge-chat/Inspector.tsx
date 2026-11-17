import type React from "react";
import {
  AlertCircle,
  BookMarked,
  CircleDot,
  FileText,
  Link2,
} from "lucide-react";
import { ToolCall, type ToolEntry } from "@/components/ToolCall";
import type { KnowledgeCaptureDraft, KnowledgeReadingDraft } from "@/lib/api";
import type { KnowledgeSourceHint } from "@/lib/knowledgeChatState";
import { cn } from "@/lib/utils";
import {
  OPEN_STATUSES,
  PanelEmpty,
  LoadingBlock,
  sourceTypeColor,
  sourceTypeLabel,
  type InspectorTab,
  type InspectorObjectRef,
  type WorkbenchMode,
  type WorkbenchSelection,
  InfoGrid,
  answerDraftTypeLabel,
  modeLabel,
  readingDraftCaptureId,
  selectionLabel,
  statusLabel,
} from "./shared";

export function KnowledgeInspector({
  answerDetail,
  connection,
  currentToolName,
  detail,
  inspectorObjectRef,
  mode,
  objectEventsError,
  objectEventsLoading,
  onTabChange,
  openCount,
  running,
  selection,
  sourceEmptyText,
  sourceHints,
  tab,
  tools,
  toolsEmptyText,
  turnIndex,
}: {
  answerDetail: KnowledgeReadingDraft | null;
  connection: string;
  currentToolName: string | null;
  detail: KnowledgeCaptureDraft | null;
  inspectorObjectRef: InspectorObjectRef;
  mode: WorkbenchMode;
  objectEventsError: string;
  objectEventsLoading: boolean;
  onTabChange: (tab: InspectorTab) => void;
  openCount: number;
  running: boolean;
  selection: WorkbenchSelection | null;
  sourceEmptyText: string;
  sourceHints: KnowledgeSourceHint[];
  tab: InspectorTab;
  tools: ToolEntry[];
  toolsEmptyText: string;
  turnIndex: number;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex shrink-0 gap-1 border-b border-border/80 p-2">
        {[
          ["sources", "来源"],
          ["tools", "工具"],
          ["status", "状态"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onTabChange(key as InspectorTab)}
            className={cn(
              "flex-1 rounded px-2 py-1.5 text-xs transition",
              tab === key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "sources" && (
          <InspectorPanel title="引用与来源" icon={BookMarked}>
            {sourceHints.length ? (
              <div className="space-y-2">
                {sourceHints.map((source) => (
                  <div
                    key={source.id}
                    className="rounded-md border border-current/10 bg-background/55 p-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
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
              <PanelEmpty text={sourceEmptyText} />
            )}
          </InspectorPanel>
        )}

        {tab === "tools" && (
          <InspectorPanel title="工具调用" icon={FileText}>
            {objectEventsError && inspectorObjectRef ? (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5" />
                <span>{objectEventsError}</span>
              </div>
            ) : null}
            {objectEventsLoading && inspectorObjectRef ? (
              <LoadingBlock text="读取工具记录..." />
            ) : tools.length ? (
              <div className="space-y-2">
                {tools.slice().reverse().map((tool, index, reversed) => {
                  const previous = reversed[index - 1];
                  const showSep =
                    tool.turnIndex != null &&
                    previous?.turnIndex != null &&
                    tool.turnIndex !== previous.turnIndex;
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
                })}
              </div>
            ) : (
              <PanelEmpty text={toolsEmptyText} />
            )}
          </InspectorPanel>
        )}

        {tab === "status" && (
          <InspectorPanel title="当前状态" icon={CircleDot}>
            <StatusInspector
              answerDetail={answerDetail}
              connection={connection}
              currentToolName={currentToolName}
              detail={detail}
              inspectorObjectRef={inspectorObjectRef}
              mode={mode}
              objectEventsLoading={objectEventsLoading}
              openCount={openCount}
              running={running}
              selection={selection}
              toolsCount={tools.length}
              turnIndex={turnIndex}
            />
          </InspectorPanel>
        )}
      </div>
    </aside>
  );
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
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background/72">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/80 px-3 py-2.5">
        <Icon className="h-4 w-4 text-primary/80" />
        <h2 className="text-sm font-semibold tracking-normal text-foreground">
          {title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

export function StatusInspector({
  answerDetail,
  connection,
  currentToolName,
  detail,
  inspectorObjectRef,
  mode,
  openCount,
  objectEventsLoading,
  running,
  selection,
  toolsCount,
  turnIndex,
}: {
  answerDetail: KnowledgeReadingDraft | null;
  connection: string;
  currentToolName: string | null;
  detail: KnowledgeCaptureDraft | null;
  inspectorObjectRef: InspectorObjectRef;
  mode: WorkbenchMode;
  openCount: number;
  objectEventsLoading: boolean;
  running: boolean;
  selection: WorkbenchSelection | null;
  toolsCount: number;
  turnIndex: number;
}) {
  if (mode === "answer_draft_review" && answerDetail) {
    const captureId = readingDraftCaptureId(answerDetail);
    const canCreateCard =
      answerDetail.output_type === "local_learning_note"
      && answerDetail.status === "committed"
      && Boolean(captureId);
    return (
      <div className="space-y-3">
        <InfoGrid
          rows={[
            ["当前对象", answerDetail.title || "资料笔记"],
            ["对象类型", answerDraftTypeLabel(answerDetail.output_type)],
            ["Draft ID", answerDetail.id],
            ["文稿状态", statusLabel(answerDetail.status)],
            ["Capture ID", captureId || "未关联"],
            ["可转知识卡片", canCreateCard ? "可以" : "不可"],
            ["工具/事件", objectEventsLoading ? "读取中" : `${toolsCount} 条`],
            ["最近更新", answerDetail.updated_at || "未记录"],
          ]}
        />
      </div>
    );
  }

  if ((mode === "draft_review" || mode === "editable_capture") && detail) {
    const isOpenDraft = OPEN_STATUSES.has(detail.status);
    const canCreateCard = detail.status === "committed" && Boolean(detail.committed_capture_id?.trim());
    return (
      <div className="space-y-3">
        <InfoGrid
          rows={[
            ["当前对象", detail.title || "材料草稿"],
            ["对象类型", "Capture 材料"],
            ["Draft ID", detail.id],
            ["草稿状态", statusLabel(detail.status)],
            ["来源类型", detail.source_type || "未记录"],
            ["已保存 Capture", detail.committed_capture_id || "尚未生成"],
            ["可确认保存", isOpenDraft ? "可以" : "不可"],
            ["可转知识卡片", canCreateCard ? "可以" : "不可"],
            ["工具/事件", objectEventsLoading ? "读取中" : `${toolsCount} 条`],
            ["最近更新", detail.updated_at || "未记录"],
          ]}
        />
      </div>
    );
  }

  const rows: Array<[string, string]> = [
    ["当前对象", inspectorObjectRef?.label || "当前对话"],
    ["当前模式", modeLabel(mode)],
    ["连接状态", connection],
    ["运行状态", running ? "Hermes 正在处理" : "空闲"],
    ["对话轮次", String(turnIndex)],
    ["待审草稿", String(openCount)],
    ["工具调用", String(toolsCount)],
    ["当前选择", selection ? selectionLabel(selection) : "当前对话"],
  ];
  if (currentToolName) rows.splice(4, 0, ["当前工具", currentToolName]);

  return (
    <div className="space-y-3">
      <InfoGrid rows={rows} />
    </div>
  );
}
