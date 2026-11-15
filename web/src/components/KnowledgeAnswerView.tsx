import { ChevronDown, ExternalLink, Link2 } from "lucide-react";
import { Markdown, type MarkdownSource } from "@/components/Markdown";

export interface KnowledgeAnswerSource extends MarkdownSource {
  domain?: string;
}

const MODEL_SUPPLEMENT_MARKER = "💡 延伸补充（模型通识）：";

export function KnowledgeAnswerView({
  content,
  onSourceOpen,
  onSourceOpenLocal,
  sources,
  streaming,
  searchBackend,
}: {
  content: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  onSourceOpenLocal?: (source: KnowledgeAnswerSource) => void;
  sources?: {
    knowledge?: KnowledgeAnswerSource[];
    web?: KnowledgeAnswerSource[];
  };
  streaming?: boolean;
  /** "deepseek" | "fallback" | "unknown" — surfaced when the search degraded. */
  searchBackend?: string;
}) {
  const knowledge = [
    ...(sources?.knowledge ?? []),
    ...(sources?.web ?? []).filter(isKnowledgeAnswerSource),
  ];
  const web = (sources?.web ?? []).filter((source) => !isKnowledgeAnswerSource(source));
  const presentation = buildSourcePresentation(content, knowledge, web);
  const citationSources = [...presentation.knowledge, ...presentation.web];
  const blocks = splitModelSupplementBlocks(
    stripTrailingReferenceSection(presentation.content),
  );
  const degraded =
    Boolean(searchBackend) && searchBackend !== "deepseek" && searchBackend !== "unknown";

  return (
    <>
      {blocks.map((block, index) =>
        block.supplement ? (
          <div
            key={`supplement-${index}`}
            className="my-3 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-950/20"
          >
            <div className="mb-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              💡 延伸补充（模型通识）
            </div>
            <Markdown content={block.text} sources={citationSources} streaming={streaming} />
          </div>
        ) : (
          <Markdown
            key={`body-${index}`}
            content={block.text}
            onSourceOpen={(source) => openKnowledgeSource(source, onSourceOpen)}
            sources={citationSources}
            streaming={streaming}
          />
        ),
      )}
      {degraded ? (
        <div className="mt-2 text-xs text-warning">
          当前使用备用搜索源（{searchBackend}），联网结果的可信度与 DeepSeek 原生搜索不同。
        </div>
      ) : null}
      {!streaming ? (
        <KnowledgeSourceList
          content={presentation.content}
          onSourceOpen={onSourceOpen}
          onSourceOpenLocal={onSourceOpenLocal}
          sources={{ knowledge: presentation.knowledge, web: presentation.web }}
        />
      ) : null}
    </>
  );
}

function splitModelSupplementBlocks(
  content: string,
): { text: string; supplement: boolean }[] {
  // Only a top-level paragraph that *opens* with the marker becomes a callout.
  // Splitting on blank lines alone used to cut fenced code blocks and tables in
  // half, so the fence state is tracked while walking the paragraphs.
  const blocks: { text: string; supplement: boolean }[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    if (!buffer.length) return;
    const paragraph = buffer.join("\n");
    buffer = [];
    const trimmed = paragraph.trimStart();
    if (!trimmed.startsWith(MODEL_SUPPLEMENT_MARKER)) {
      blocks.push({ text: paragraph, supplement: false });
      return;
    }
    blocks.push({
      text: trimmed.slice(MODEL_SUPPLEMENT_MARKER.length).trimStart(),
      supplement: true,
    });
  };

  for (const line of content.split("\n")) {
    const isFence = line.trimStart().startsWith("```");
    if (isFence) inFence = !inFence;
    if (!inFence && line.trim() === "" && !isFence) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks.filter((block) => block.text.trim().length > 0);
}

function KnowledgeSourceList({
  content,
  onSourceOpen,
  onSourceOpenLocal,
  sources,
}: {
  content: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  onSourceOpenLocal?: (source: KnowledgeAnswerSource) => void;
  sources: {
    knowledge: KnowledgeAnswerSource[];
    web: KnowledgeAnswerSource[];
  };
}) {
  const citedRefs = sourceRefsFromContent(content);
  const knowledge = orderSources(sources.knowledge, citedRefs);
  const web = orderSources(sources.web, citedRefs);
  const allSources = [...knowledge, ...web];
  if (!allSources.length) {
    return citedRefs.length ? (
      <div className="mt-3 text-xs text-warning">
        部分引用来源缺失，已以普通文本显示。
      </div>
    ) : null;
  }
  const sourceListLabel = citedRefs.length ? "引用来源" : "使用来源";
  const availableRefs = new Set(allSources.flatMap((source) => sourceRefAliases(sourceRef(source))));
  const missingRefs = citedRefs.filter((ref) => !availableRefs.has(ref));

  return (
    <details className="mt-3 text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground transition hover:text-foreground">
        <Link2 className="h-3 w-3" />
        {sourceListLabel} {allSources.length}
        <ChevronDown className="h-3 w-3" />
      </summary>
      <div className="mt-2 border-t border-border/50 pt-2">
        {missingRefs.length ? (
          <div className="mb-2 text-warning">
            部分引用来源缺失，已以普通文本显示。
          </div>
        ) : null}
        {orderedGroups(knowledge, web, citedRefs).map((group) => (
          <SourceListGroup
            key={group.label}
            label={group.label}
            onSourceOpen={onSourceOpen}
            onSourceOpenLocal={onSourceOpenLocal}
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
  onSourceOpenLocal,
  sources,
}: {
  label: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  onSourceOpenLocal?: (source: KnowledgeAnswerSource) => void;
  sources: KnowledgeAnswerSource[];
}) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 font-medium text-foreground">{label}</div>
      <ul className="space-y-1">
        {sources.map((source, index) => (
          <li key={`${source.ref || index}-${source.url || source.id || source.title}`} className="break-words">
            <SourceLink
              onSourceOpen={onSourceOpen}
              onSourceOpenLocal={onSourceOpenLocal}
              source={source}
              fallbackRef={source.ref || `${index + 1}`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceLink({
  fallbackRef,
  onSourceOpen,
  onSourceOpenLocal,
  source,
}: {
  fallbackRef: string;
  onSourceOpen?: (source: KnowledgeAnswerSource) => void;
  onSourceOpenLocal?: (source: KnowledgeAnswerSource) => void;
  source: KnowledgeAnswerSource;
}) {
  const label = source.title || source.id || source.url || "未命名来源";
  const isKnowledge = isKnowledgeAnswerSource(source);
  const badge = sourceBadge(source);
  const badgeClass =
    "rounded border border-border/70 bg-background/70 px-1 py-0 text-[0.65rem] font-normal text-muted-foreground no-underline";
  const suffix = source.section
    ? ` / ${source.section}`
    : source.url && !isKnowledge
      ? ` · ${source.domain || hostLabel(source.url)}`
      : "";
  if (source.url && !isKnowledge) {
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60"
      >
        <ExternalLink className="h-3 w-3" />
        <span className={badgeClass}>{badge}</span>
        [{source.ref || fallbackRef}] {label}{suffix}
      </a>
    );
  }

  const text = `[${source.ref || fallbackRef}] ${label}${suffix}`;
  const canOpen = canOpenKnowledgeSource(source, onSourceOpen);
  const canOpenLocal = canOpenKnowledgeSourceLocal(source, onSourceOpenLocal);
  const fileUrl = source.file_url || "";
  if (!canOpen && !canOpenLocal && !fileUrl) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className={badgeClass}>{badge}</span>
        <span>{text}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={badgeClass}>{badge}</span>
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
      {canOpenLocal ? (
        <button
          type="button"
          onClick={() => onSourceOpenLocal?.(source)}
          className="rounded border border-border px-1.5 py-0.5 text-[0.68rem] text-muted-foreground no-underline hover:border-primary/30 hover:text-foreground"
        >
          文件
        </button>
      ) : fileUrl ? (
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

function canOpenKnowledgeSourceLocal(
  source: KnowledgeAnswerSource,
  onSourceOpenLocal?: (source: KnowledgeAnswerSource) => void,
): boolean {
  return Boolean(onSourceOpenLocal && source.item_kind === "capture" && source.item_id);
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
    { label: "📚 个人知识库（卡片与资料）", sources: knowledge, fallbackOrder: 0 },
    { label: "🌐 DeepSeek 联网来源", sources: web, fallbackOrder: 1 },
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
  return content.replace(/\\?\[([KW]?\d+)\]/gi, (match, ref: string) => {
    const displayRef = displayMap.get(ref.toUpperCase());
    return displayRef ? `[${displayRef}]` : match;
  });
}

function sourceRefsFromContent(content: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\\?\[([KW]?\d+)\]/gi)) {
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

function sourceBadge(source: KnowledgeAnswerSource): string {
  if (!isKnowledgeAnswerSource(source)) return "🌐 网页";
  if (isKnowledgeCardSource(source)) return "🗂️ 卡片";
  return "📄 资料";
}

function isKnowledgeCardSource(source: KnowledgeAnswerSource): boolean {
  const type = (source.type || "").toLowerCase();
  return Boolean(
    type === "knowledge_card" ||
    type === "garden_card" ||
    source.item_kind === "garden_card" ||
    (source.title && source.title.includes("【知识卡片】")),
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
