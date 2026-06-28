import { ChevronDown, ExternalLink, Link2 } from "lucide-react";
import { Markdown, type MarkdownSource } from "@/components/Markdown";

export interface KnowledgeAnswerSource extends MarkdownSource {
  domain?: string;
}

export function KnowledgeAnswerView({
  content,
  onSourceOpen,
  sources,
  streaming,
}: {
  content: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  sources?: {
    knowledge?: KnowledgeAnswerSource[];
    web?: KnowledgeAnswerSource[];
  };
  streaming?: boolean;
}) {
  const knowledge = [
    ...(sources?.knowledge ?? []),
    ...(sources?.web ?? []).filter(isKnowledgeAnswerSource),
  ];
  const web = (sources?.web ?? []).filter((source) => !isKnowledgeAnswerSource(source));
  const presentation = buildSourcePresentation(content, knowledge, web);
  const citationSources = [...presentation.knowledge, ...presentation.web];

  return (
    <>
      <Markdown
        content={stripTrailingReferenceSection(presentation.content)}
        onSourceOpen={(source) => openKnowledgeSource(source, onSourceOpen)}
        sources={citationSources}
        streaming={streaming}
      />
      {!streaming ? (
        <KnowledgeSourceList
          content={presentation.content}
          onSourceOpen={onSourceOpen}
          sources={{ knowledge: presentation.knowledge, web: presentation.web }}
        />
      ) : null}
    </>
  );
}

function KnowledgeSourceList({
  content,
  onSourceOpen,
  sources,
}: {
  content: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  sources: {
    knowledge: KnowledgeAnswerSource[];
    web: KnowledgeAnswerSource[];
  };
}) {
  const citedRefs = sourceRefsFromContent(content);
  const knowledge = orderSources(sources.knowledge, citedRefs);
  const web = orderSources(sources.web, citedRefs);
  const allSources = [...knowledge, ...web];
  if (!allSources.length) return null;

  return (
    <details className="mt-3 text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground transition hover:text-foreground">
        <Link2 className="h-3 w-3" />
        引用来源 {allSources.length}
        <ChevronDown className="h-3 w-3" />
      </summary>
      <div className="mt-2 border-t border-border/50 pt-2">
        {orderedGroups(knowledge, web, citedRefs).map((group) => (
          <SourceListGroup
            key={group.label}
            label={group.label}
            onSourceOpen={onSourceOpen}
            sources={group.sources}
          />
        ))}
      </div>
    </details>
  );
}

function SourceListGroup({
  label,
  onSourceOpen,
  sources,
}: {
  label: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  sources: KnowledgeAnswerSource[];
}) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 font-medium text-foreground">{label}</div>
      <ul className="space-y-1">
        {sources.map((source, index) => (
          <li key={`${source.ref || index}-${source.url || source.id || source.title}`} className="break-words">
            <SourceLink onSourceOpen={onSourceOpen} source={source} fallbackRef={source.ref || `${index + 1}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceLink({
  fallbackRef,
  onSourceOpen,
  source,
}: {
  fallbackRef: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  source: KnowledgeAnswerSource;
}) {
  const label = source.title || source.id || source.url || "未命名来源";
  const suffix = source.section
    ? ` / ${source.section}`
    : source.url
      ? ` · ${source.domain || hostLabel(source.url)}`
      : "";
  if (source.url) {
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60"
      >
        <ExternalLink className="h-3 w-3" />
        [{source.ref || fallbackRef}] {label}{suffix}
      </a>
    );
  }

  const text = `[${source.ref || fallbackRef}] ${label}${suffix}`;
  const canOpen = canOpenKnowledgeSource(source, onSourceOpen);
  const fileUrl = source.file_url || "";
  if (!canOpen && !fileUrl) return <span>{text}</span>;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {canOpen ? (
        <button
          type="button"
          onClick={() => openKnowledgeSource(source, onSourceOpen)}
          className="text-left text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60"
        >
          {text}
        </button>
      ) : (
        <span>{text}</span>
      )}
      {fileUrl ? (
        <a
          href={fileUrl}
          className="rounded border border-border px-1.5 py-0.5 text-[0.68rem] text-muted-foreground no-underline hover:border-primary/30 hover:text-foreground"
        >
          文件
        </a>
      ) : null}
    </span>
  );
}

function openKnowledgeSource(
  source: KnowledgeAnswerSource,
  onSourceOpen?: (source: KnowledgeAnswerSource) => void,
) {
  if (onSourceOpen) {
    onSourceOpen(source);
    return;
  }
  const openUrl = source.open_url || inferredOpenUrl(source);
  if (openUrl) {
    window.location.assign(openUrl);
  }
}

function canOpenKnowledgeSource(
  source: KnowledgeAnswerSource,
  onSourceOpen?: (source: KnowledgeAnswerSource) => void,
): boolean {
  return Boolean(onSourceOpen || source.open_url || inferredOpenUrl(source));
}

function inferredOpenUrl(source: KnowledgeAnswerSource): string | undefined {
  return source.item_kind && source.item_id
    ? `/knowledge-library?kind=${encodeURIComponent(source.item_kind)}&item=${encodeURIComponent(source.item_id)}`
    : undefined;
}

function orderSources(
  sources: KnowledgeAnswerSource[],
  citedRefs: string[],
): KnowledgeAnswerSource[] {
  if (!sources.length || !citedRefs.length) return sources;
  const order = new Map(citedRefs.map((ref, index) => [ref, index]));
  return sources
    .map((source, index) => ({
      source,
      index,
      order: sourceOrder(source, order),
    }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.source);
}

function orderedGroups(
  knowledge: KnowledgeAnswerSource[],
  web: KnowledgeAnswerSource[],
  citedRefs: string[],
): Array<{ label: string; sources: KnowledgeAnswerSource[] }> {
  const groups = [
    { label: "知识库来源", sources: knowledge, fallbackOrder: 0 },
    { label: "联网来源", sources: web, fallbackOrder: 1 },
  ].filter((group) => group.sources.length);
  if (!citedRefs.length) return groups;
  const order = new Map(citedRefs.map((ref, index) => [ref, index]));
  return groups.sort((a, b) => {
    const aOrder = minSourceOrder(a.sources, order);
    const bOrder = minSourceOrder(b.sources, order);
    return aOrder - bOrder || a.fallbackOrder - b.fallbackOrder;
  });
}

function minSourceOrder(
  sources: KnowledgeAnswerSource[],
  order: Map<string, number>,
): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const source of sources) {
    min = Math.min(min, sourceOrder(source, order));
  }
  return min;
}

function buildSourcePresentation(
  content: string,
  knowledge: KnowledgeAnswerSource[],
  web: KnowledgeAnswerSource[],
): {
  content: string;
  knowledge: KnowledgeAnswerSource[];
  web: KnowledgeAnswerSource[];
} {
  const citedRefs = sourceRefsFromContent(content);
  const citedOrder = new Map(citedRefs.map((ref, index) => [ref, index]));
  const knowledgeOrdered = orderSources(knowledge, citedRefs);
  const webOrdered = orderSources(web, citedRefs);
  const displayMap = new Map<string, string>();
  const displayKnowledge = withDisplayRefs(knowledgeOrdered, "K", citedOrder, displayMap);
  const displayWeb = withDisplayRefs(webOrdered, "W", citedOrder, displayMap);
  return {
    content: rewriteCitationRefs(content, displayMap),
    knowledge: displayKnowledge,
    web: displayWeb,
  };
}

function withDisplayRefs(
  sources: KnowledgeAnswerSource[],
  prefix: "K" | "W",
  citedOrder: Map<string, number>,
  displayMap: Map<string, string>,
): KnowledgeAnswerSource[] {
  return sources.map((source, index) => {
    const originalRef = sourceRef(source);
    const displayRef = `${prefix}${index + 1}`;
    const aliases = sourceRefAliases(originalRef);
    if (aliases.some((ref) => citedOrder.has(ref))) {
      for (const ref of aliases) {
        displayMap.set(ref, displayRef);
      }
    }
    return { ...source, ref: displayRef };
  });
}

function rewriteCitationRefs(content: string, displayMap: Map<string, string>): string {
  if (!displayMap.size) return content;
  return content.replace(/\[([KW]?\d+)\]/gi, (match, ref: string) => {
    const displayRef = displayMap.get(ref.toUpperCase());
    return displayRef ? `[${displayRef}]` : match;
  });
}

function sourceRefsFromContent(content: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[([KW]?\d+)\]/gi)) {
    const ref = match[1].toUpperCase();
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function sourceRef(source: KnowledgeAnswerSource): string {
  return (source.ref || "").trim().toUpperCase();
}

function isKnowledgeAnswerSource(source: KnowledgeAnswerSource): boolean {
  const type = (source.type || "").toLowerCase();
  const ref = sourceRef(source);
  return Boolean(
    source.item_kind ||
    type === "knowledge" ||
    type === "capture" ||
    type === "capture_note" ||
    type === "capture_section" ||
    type === "capture_draft" ||
    ref.startsWith("K") ||
    /^\d+$/.test(ref),
  );
}

function sourceOrder(
  source: KnowledgeAnswerSource,
  order: Map<string, number>,
): number {
  for (const ref of sourceRefAliases(sourceRef(source))) {
    const value = order.get(ref);
    if (value !== undefined) return value;
  }
  return Number.MAX_SAFE_INTEGER;
}

function sourceRefAliases(ref: string): string[] {
  if (!ref) return [];
  const aliases = [ref];
  const numeric = ref.match(/^K(\d+)$/i)?.[1];
  if (numeric) aliases.push(numeric);
  if (/^\d+$/.test(ref)) aliases.push(`K${ref}`);
  return aliases;
}

function stripTrailingReferenceSection(content: string): string {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => /^#{0,6}\s*(参考来源|来源|引用|references?)\s*[:：]?\s*$/i.test(line.trim()));
  if (index < 0) return content;
  return lines.slice(0, index).join("\n").trimEnd();
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
