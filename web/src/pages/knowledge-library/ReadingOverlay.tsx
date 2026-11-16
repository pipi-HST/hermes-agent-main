import { useCallback, useRef } from "react";
import { Minimize2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import {
  type ArticleSelectionContext,
  selectionContextFromDomSelection,
  selectionContextFromSelectedText,
} from "./selection";

export function ImmersiveReadingOverlay({
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

export function ReadonlyMarkdownDocument({
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
