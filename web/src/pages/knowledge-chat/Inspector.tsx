import {
  BookMarked,
  Link2,
} from "lucide-react";
import type { ToolEntry } from "@/components/ToolCall";
import type { KnowledgeCaptureDraft, KnowledgeReadingDraft } from "@/lib/api";
import type { KnowledgeSourceHint } from "@/lib/knowledgeChatState";
import {
  OPEN_STATUSES,
  PanelEmpty,
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
  sourceEmptyText,
  sourceHints,
}: {
  answerDetail?: KnowledgeReadingDraft | null;
  connection?: string;
  currentToolName?: string | null;
  detail?: KnowledgeCaptureDraft | null;
  inspectorObjectRef?: InspectorObjectRef;
  mode?: WorkbenchMode;
  objectEventsError?: string;
  objectEventsLoading?: boolean;
  onTabChange?: (tab: InspectorTab) => void;
  openCount?: number;
  running?: boolean;
  selection?: WorkbenchSelection | null;
  sourceEmptyText: string;
  sourceHints: KnowledgeSourceHint[];
  tab?: InspectorTab;
  tools?: ToolEntry[];
  toolsEmptyText?: string;
  turnIndex?: number;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-black/[0.07] bg-[#f7f7f4]/80 dark:border-border/70 dark:bg-card/60">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/55 px-4 py-3">
        <div className="flex items-center gap-2">
          <BookMarked className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-xs font-medium text-foreground">参考依据</h2>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {sourceHints.length} 条
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sourceHints.length ? (
          <div className="space-y-2">
            {sourceHints.map((source) => (
              <div
                key={source.id}
                className="rounded-xl border border-black/[0.06] bg-white p-3 transition hover:border-foreground/20 dark:border-border/60 dark:bg-card"
              >
                <div className="flex items-start gap-2">
                  <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    {source.sourceType && (
                      <div className="mb-0.5 text-[10.5px] font-medium text-muted-foreground">
                        {sourceTypeLabel(source.sourceType)}
                      </div>
                    )}
                    <p className="break-words text-xs font-medium leading-5 text-foreground">
                      {source.url ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/70"
                        >
                          {source.label}
                        </a>
                      ) : (
                        source.label
                      )}
                    </p>
                    {source.excerpt && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                        {source.excerpt}
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
      </div>
    </aside>
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
