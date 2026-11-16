import type { ReactNode } from "react";
import { FilePlus2, FileText, Loader2, UploadCloud } from "lucide-react";
import type { KnowledgeLibraryItem } from "@/lib/api";
import { cn } from "@/lib/utils";

export function StatusBadge({ item }: { item: KnowledgeLibraryItem }) {
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

export function TinyPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-background/70 px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">
      {children}
    </span>
  );
}

export function LoadingState({ text }: { text: string }) {
  return (
    <div className="flex min-h-[220px] items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
  );
}

export function EmptyState({
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
