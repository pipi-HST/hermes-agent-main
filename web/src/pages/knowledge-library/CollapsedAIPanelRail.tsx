import { ChevronLeft, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function CollapsedAIPanelRail({
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
