import { useCallback, useRef } from "react";
import { Minimize2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import {
  type ArticleSelectionContext,
  selectionContextFromDomSelection,
  selectionContextFromSelectedText,
} from "./selection";

const EDITORIAL_PROSE_CLASSES =
  "[&_[data-markdown-root]]:space-y-4 [&_[data-markdown-root]]:text-[15.5px] [&_[data-markdown-root]]:leading-[1.9] [&_[data-markdown-root]]:text-foreground/88 " +
  "[&_[data-markdown-root]_h1]:pt-3 [&_[data-markdown-root]_h1]:text-xl [&_[data-markdown-root]_h1]:font-semibold [&_[data-markdown-root]_h1]:tracking-tight [&_[data-markdown-root]_h1]:text-foreground " +
  "[&_[data-markdown-root]_h2]:pt-3 [&_[data-markdown-root]_h2]:text-[17px] [&_[data-markdown-root]_h2]:font-semibold [&_[data-markdown-root]_h2]:tracking-tight [&_[data-markdown-root]_h2]:text-foreground " +
  "[&_[data-markdown-root]_h3]:pt-2 [&_[data-markdown-root]_h3]:text-[15.5px] [&_[data-markdown-root]_h3]:font-semibold [&_[data-markdown-root]_h3]:text-foreground " +
  "[&_[data-markdown-root]_ul]:space-y-2.5 [&_[data-markdown-root]_ul]:pl-5 [&_[data-markdown-root]_ul]:text-[15.5px] " +
  "[&_[data-markdown-root]_ol]:space-y-2.5 [&_[data-markdown-root]_ol]:pl-5 [&_[data-markdown-root]_ol]:text-[15.5px] " +
  "[&_[data-markdown-root]_li]:leading-[1.85] " +
  "[&_[data-markdown-root]_strong]:font-semibold [&_[data-markdown-root]_strong]:text-foreground " +
  "[&_[data-markdown-root]_blockquote]:rounded-xl [&_[data-markdown-root]_blockquote]:border-0 [&_[data-markdown-root]_blockquote]:bg-muted/45 [&_[data-markdown-root]_blockquote]:px-4 [&_[data-markdown-root]_blockquote]:py-3 [&_[data-markdown-root]_blockquote]:text-[14.5px] [&_[data-markdown-root]_blockquote]:leading-[1.8] [&_[data-markdown-root]_blockquote]:text-foreground/80 " +
  "[&_[data-markdown-root]_pre]:rounded-xl [&_[data-markdown-root]_pre]:border-black/[0.08] [&_[data-markdown-root]_pre]:bg-muted/40";

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
    <div className="fixed inset-0 z-[80] flex min-h-0 flex-col bg-[#fafaf8] text-foreground dark:bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-6">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">{title}</h1>
        <button
          type="button"
          onClick={onExit}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/80 bg-white px-3 text-xs text-muted-foreground transition hover:border-foreground/25 hover:text-foreground dark:bg-card"
          title="退出沉浸阅读"
          aria-label="退出沉浸阅读"
        >
          <Minimize2 className="h-3.5 w-3.5" />
          退出沉浸阅读
        </button>
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <article className={`mx-auto max-w-[740px] rounded-2xl border border-black/[0.06] bg-white px-8 py-9 shadow-[0_1px_3px_rgba(0,0,0,0.03)] dark:border-border dark:bg-card sm:px-12 ${EDITORIAL_PROSE_CLASSES}`}>
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
      className="h-full min-h-[360px] overflow-y-auto px-6 py-6 sm:px-9 sm:py-7"
      onKeyUpCapture={updateSelection}
      onMouseUpCapture={updateSelection}
    >
      <div className={`mx-auto max-w-[740px] ${EDITORIAL_PROSE_CLASSES}`}>
        {body.trim() ? (
          <Markdown content={body} enableKnowledgeOutlineLinks />
        ) : (
          <p className="text-sm text-muted-foreground">暂无正文</p>
        )}
      </div>
    </article>
  );
}
