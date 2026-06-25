import { ExternalLink } from "lucide-react";
import { useMemo, type ReactNode } from "react";

export interface MarkdownSource {
  ref?: string;
  type?: string;
  id?: string;
  title?: string;
  url?: string;
  path?: string;
  section?: string;
}

/**
 * Lightweight markdown renderer for LLM output.
 * Handles: code blocks, inline code, bold, italic, headers, links, lists, horizontal rules.
 * NOT a full CommonMark parser — optimized for typical assistant message patterns.
 *
 * `streaming` renders a blinking caret at the tail of the last block so it
 * appears to hug the final character instead of wrapping onto a new line
 * after a block element (paragraph/list/code/…).
 */
export function Markdown({
  content,
  highlightTerms,
  sources,
  streaming,
}: {
  content: string;
  highlightTerms?: string[];
  sources?: MarkdownSource[];
  streaming?: boolean;
}) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const sourceMap = useMemo(() => buildSourceMap(sources), [sources]);
  const caret = streaming ? <StreamingCaret /> : null;

  return (
    <div className="text-sm text-foreground leading-relaxed space-y-2">
      {blocks.map((block, i) => (
        <Block
          key={i}
          block={block}
          highlightTerms={highlightTerms}
          sourceMap={sourceMap}
          caret={caret && i === blocks.length - 1 ? caret : null}
        />
      ))}
      {blocks.length === 0 && caret}
    </div>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="inline-block w-[0.5em] h-[1em] ml-0.5 align-[-0.15em] bg-foreground/50 animate-pulse"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type BlockNode =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "hr" }
  | { type: "quote"; content: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; content: string };

/* ------------------------------------------------------------------ */
/*  Block parser                                                       */
/* ------------------------------------------------------------------ */

function parseBlocks(text: string): BlockNode[] {
  const lines = text.split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // Pipe table — header row followed by separator row (|---|---|)
    if (
      line.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const parseRow = (r: string) =>
        r
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());

      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Block quote
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", content: quoteLines.join("\n") });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-empty, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].match(/^>\s?/) &&
      !lines[i].match(/^[-*+]\s/) &&
      !lines[i].match(/^\d+[.)]\s/) &&
      !lines[i].match(/^[-*_]{3,}\s*$/) &&
      !lines[i].startsWith("|")
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", content: paraLines.join("\n") });
    }
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/*  Block renderer                                                     */
/* ------------------------------------------------------------------ */

function Block({
  block,
  highlightTerms,
  sourceMap,
  caret,
}: {
  block: BlockNode;
  highlightTerms?: string[];
  sourceMap: Map<string, MarkdownSource>;
  caret?: ReactNode;
}) {
  switch (block.type) {
    case "code":
      return (
        <pre className="bg-secondary/60 border border-border px-3 py-2.5 text-xs font-mono leading-relaxed overflow-x-auto">
          <code>
            {block.content}
            {caret}
          </code>
        </pre>
      );

    case "heading": {
      const Tag = `h${Math.min(block.level, 4)}` as "h1" | "h2" | "h3" | "h4";
      const sizes: Record<string, string> = {
        h1: "text-base font-bold",
        h2: "text-sm font-bold",
        h3: "text-sm font-semibold",
        h4: "text-sm font-medium",
      };
      return (
        <Tag className={sizes[Tag]}>
          <InlineContent text={block.content} highlightTerms={highlightTerms} sourceMap={sourceMap} />
          {caret}
        </Tag>
      );
    }

    case "hr":
      return (
        <>
          <hr className="border-border" />
          {caret}
        </>
      );

    case "quote":
      return (
        <blockquote className="border-l-2 border-primary/35 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">
          <InlineContent text={block.content} highlightTerms={highlightTerms} sourceMap={sourceMap} />
          {caret}
        </blockquote>
      );

    case "table": {
      const colCount = block.headers.length;
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {block.headers.map((h, ci) => (
                  <th
                    key={ci}
                    className="border border-border bg-secondary/40 px-2.5 py-1.5 text-left font-semibold"
                  >
                    <InlineContent text={h} highlightTerms={highlightTerms} sourceMap={sourceMap} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {Array.from({ length: colCount }).map((_, ci) => (
                    <td
                      key={ci}
                      className="border border-border px-2.5 py-1.5"
                    >
                      <InlineContent
                        text={row[ci] ?? ""}
                        highlightTerms={highlightTerms}
                        sourceMap={sourceMap}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {caret}
        </div>
      );
    }

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      const last = block.items.length - 1;
      return (
        <Tag
          className={`space-y-0.5 ${block.ordered ? "list-decimal" : "list-disc"} pl-5 text-sm`}
        >
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineContent text={item} highlightTerms={highlightTerms} sourceMap={sourceMap} />
              {i === last ? caret : null}
            </li>
          ))}
        </Tag>
      );
    }

    case "paragraph":
      return (
        <p>
          <InlineContent text={block.content} highlightTerms={highlightTerms} sourceMap={sourceMap} />
          {caret}
        </p>
      );
  }
}

/* ------------------------------------------------------------------ */
/*  Inline parser + renderer                                           */
/* ------------------------------------------------------------------ */

type InlineNode =
  | { type: "text"; content: string }
  | { type: "code"; content: string }
  | { type: "bold"; content: string }
  | { type: "italic"; content: string }
  | { type: "link"; text: string; href: string }
  | { type: "citation"; ref: string }
  | { type: "br" };

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Pattern priority: code > link > citation > bold > italic > bare URL > line break
  const pattern =
    /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))|(\[([KW]\d+)\])|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\bhttps?:\/\/[^\s<>)\]]+)|(\n)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      // Inline code
      nodes.push({ type: "code", content: match[1].slice(1, -1) });
    } else if (match[2]) {
      // [text](url) link
      nodes.push({ type: "link", text: match[3], href: match[4] });
    } else if (match[5]) {
      // [W1]/[K1] citation refs
      nodes.push({ type: "citation", ref: match[6].toUpperCase() });
    } else if (match[7]) {
      // **bold**
      nodes.push({ type: "bold", content: match[8] });
    } else if (match[9]) {
      // *italic*
      nodes.push({ type: "italic", content: match[10] });
    } else if (match[11]) {
      // Bare URL
      nodes.push({ type: "link", text: match[11], href: match[11] });
    } else if (match[12]) {
      // Line break within paragraph
      nodes.push({ type: "br" });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", content: text.slice(lastIndex) });
  }

  return nodes;
}

function InlineContent({
  text,
  highlightTerms,
  sourceMap,
}: {
  text: string;
  highlightTerms?: string[];
  sourceMap: Map<string, MarkdownSource>;
}) {
  const nodes = useMemo(() => parseInline(text), [text]);

  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "text":
            return (
              <HighlightedText
                key={i}
                text={node.content}
                terms={highlightTerms}
              />
            );
          case "code":
            return (
              <code
                key={i}
                className="bg-secondary/60 px-1.5 py-0.5 text-xs font-mono text-primary/90"
              >
                {node.content}
              </code>
            );
          case "bold":
            return (
              <strong key={i} className="font-semibold">
                <HighlightedText text={node.content} terms={highlightTerms} />
              </strong>
            );
          case "italic":
            return (
              <em key={i}>
                <HighlightedText text={node.content} terms={highlightTerms} />
              </em>
            );
          case "citation":
            return <CitationControl key={i} refId={node.ref} source={sourceMap.get(node.ref)} />;
          case "link":
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2 decoration-primary/30 hover:decoration-primary/60 transition-colors"
              >
                {node.text}
              </a>
            );
          case "br":
            return <br key={i} />;
        }
      })}
    </>
  );
}

function CitationControl({ refId, source }: { refId: string; source?: MarkdownSource }) {
  const label = source?.title || source?.section || source?.id || refId;
  const href = source?.url || source?.path || "";
  const title = href ? `${label} ${href}` : label;
  const className = "mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded border border-primary/25 bg-primary/5 px-1 align-[0.08em] text-[0.68rem] font-medium text-primary hover:border-primary/45 hover:bg-primary/10";

  if (href) {
    return (
      <a
        href={href}
        target={source?.url ? "_blank" : undefined}
        rel={source?.url ? "noreferrer" : undefined}
        className={className}
        title={title}
        aria-label={`打开引用来源 ${label}`}
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    );
  }

  return (
    <span className={className} title={title} aria-label={`引用来源 ${label}`}>
      {refId}
    </span>
  );
}

function buildSourceMap(sources?: MarkdownSource[]): Map<string, MarkdownSource> {
  const map = new Map<string, MarkdownSource>();
  for (const source of sources || []) {
    const ref = (source.ref || "").trim().toUpperCase();
    if (ref) map.set(ref, source);
  }
  return map;
}

/** Highlight search terms within a plain text string. */
function HighlightedText({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms || terms.length === 0) return <>{text}</>;

  // Build a regex that matches any of the search terms (case-insensitive)
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-warning/30 text-warning px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
