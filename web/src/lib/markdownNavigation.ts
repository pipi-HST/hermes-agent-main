export interface MarkdownHeading {
  level: number;
  content: string;
}

export interface MarkdownHeadingAnchor extends MarkdownHeading {
  id: string;
}

export interface KnowledgeOutlineIssue {
  item: string;
  title: string;
}

export interface KnowledgeOutlineAnalysis {
  missing: KnowledgeOutlineIssue[];
}

export function markdownHeadingId(text: string): string {
  const cleaned = stripInlineMarkdown(text)
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "section";
}

export function buildHeadingAnchors(
  headings: MarkdownHeading[],
): MarkdownHeadingAnchor[] {
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    const base = markdownHeadingId(heading.content);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return {
      ...heading,
      id: count === 1 ? base : `${base}-${count}`,
    };
  });
}

export function linkKnowledgeOutlineMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const headingMatches = collectHeadings(lines);
  const outline = findOutlineRange(lines);
  if (!outline) return markdown;

  const headingAnchors = buildHeadingAnchors(headingMatches);
  const targets = headingAnchors
    .map((heading, index) => ({
      ...heading,
      lineIndex: headingMatches[index].lineIndex,
      matchKey: normalizeMatchText(stripLeadingSectionNumber(heading.content)),
    }))
    .filter((heading) => heading.lineIndex >= outline.end);

  if (targets.length === 0) return markdown;

  return lines
    .map((line, index) => {
      if (index <= outline.start || index >= outline.end) return line;
      const match = /^(\s*[-*+]\s+)(.+?)\s*$/.exec(line);
      if (!match) return line;
      const [, marker, item] = match;
      if (/^\[[^\]]+\]\(#[^)]+\)/.test(item.trim())) return line;
      const target = findOutlineTarget(item, targets);
      if (!target) return line;
      return `${marker}[${item}](#${target.id})`;
    })
    .join("\n");
}

function collectHeadings(lines: string[]): Array<MarkdownHeading & { lineIndex: number }> {
  const headings: Array<MarkdownHeading & { lineIndex: number }> = [];
  lines.forEach((line, lineIndex) => {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (!match) return;
    headings.push({
      level: match[1].length,
      content: match[2].trim(),
      lineIndex,
    });
  });
  return headings;
}

function findOutlineRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    return !!match && normalizeMatchText(match[2]) === normalizeMatchText("目录纲要");
  });
  if (start < 0) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^(#{1,4})\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function findOutlineTarget<T extends { content: string; matchKey: string }>(
  item: string,
  targets: T[],
): T | null {
  const itemKeys = outlineItemMatchKeys(item);
  let best: { target: T; score: number } | null = null;

  for (const target of targets) {
    for (const key of itemKeys) {
      if (!key) continue;
      const targetContainsKey = target.matchKey.includes(key);
      const keyContainsTarget = key.includes(target.matchKey);
      if (!targetContainsKey && !keyContainsTarget) continue;
      const score = Math.min(key.length, target.matchKey.length);
      if (!best || score > best.score) {
        best = { target, score };
      }
    }
  }

  return best?.target ?? null;
}

export function analyzeKnowledgeOutlineMarkdown(markdown: string): KnowledgeOutlineAnalysis {
  const lines = markdown.split("\n");
  const outline = findOutlineRange(lines);
  if (!outline) return { missing: [] };
  const targets = collectHeadingTargets(lines, outline.end);
  const missing: KnowledgeOutlineIssue[] = [];

  for (let index = outline.start + 1; index < outline.end; index++) {
    const match = /^(\s*[-*+]\s+)(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const item = match[2];
    if (!findOutlineTarget(item, targets)) {
      missing.push({ item, title: outlineItemTitle(item) });
    }
  }
  return { missing };
}

export function repairKnowledgeOutlineMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const outline = findOutlineRange(lines);
  if (!outline) return markdown;

  let nextMarkdown = markdown;
  for (const issue of analyzeKnowledgeOutlineMarkdown(nextMarkdown).missing) {
    const repaired = insertMissingOutlineHeading(nextMarkdown, issue.title);
    if (repaired !== nextMarkdown) {
      nextMarkdown = repaired;
    }
  }
  return nextMarkdown;
}

function collectHeadingTargets(lines: string[], afterLineIndex: number) {
  const headingMatches = collectHeadings(lines);
  const headingAnchors = buildHeadingAnchors(headingMatches);
  return headingAnchors
    .map((heading, index) => ({
      ...heading,
      lineIndex: headingMatches[index].lineIndex,
      matchKey: normalizeMatchText(stripLeadingSectionNumber(heading.content)),
    }))
    .filter((heading) => heading.lineIndex >= afterLineIndex);
}

function outlineItemMatchKeys(item: string): string[] {
  const plain = stripInlineMarkdown(item);
  const firstColon = splitAtFirstColon(plain);
  const stripped = stripLeadingSectionNumber(plain);
  return Array.from(
    new Set([
      normalizeMatchText(plain),
      normalizeMatchText(stripped),
      normalizeMatchText(firstColon),
      normalizeMatchText(stripLeadingSectionNumber(firstColon)),
      ...outlineTitleVariants(outlineItemTitle(plain)).map(normalizeMatchText),
    ]),
  ).filter(Boolean);
}

function outlineItemTitle(item: string): string {
  const plain = stripInlineMarkdown(item).trim();
  const parts = plain.split(/[：:]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && /^(引言|经验|策略|阶段|坑|附)/.test(parts[0])) {
    return `${parts[0]}：${parts[1]}`;
  }
  return parts[0] || plain;
}

function outlineTitleVariants(title: string): string[] {
  const variants = [title];
  const withoutPrefix = title.replace(/^(?:经验|策略|阶段|坑|附录?)[一二三四五六七八九十百千\d]*[：:、.．)）\-\s]*/, "").trim();
  if (withoutPrefix && withoutPrefix !== title) variants.push(withoutPrefix);
  for (const value of [...variants]) {
    const [head, tail] = value.split(/[：:—-]{1,2}/, 2);
    if (head?.trim() && head.trim() !== value) variants.push(head.trim());
    if (tail?.trim()) variants.push(tail.trim());
  }
  for (const value of [...variants]) {
    for (const part of value.split(/[，,、；;]/)) {
      const trimmed = part.trim();
      if (trimmed && trimmed !== value) variants.push(trimmed);
    }
    variants.push(value.replaceAll("的", ""));
    variants.push(value.replaceAll("学会用", "学会使用"));
    variants.push(value.replaceAll("学会使用", "学会用"));
  }
  if (/^附[：:]/.test(title)) variants.push("附上");
  return Array.from(new Set(variants.filter(Boolean)));
}

function insertMissingOutlineHeading(markdown: string, title: string): string {
  if (!title.trim()) return markdown;
  const lines = markdown.split("\n");
  const outline = findOutlineRange(lines);
  if (!outline) return markdown;
  const prefix = lines.slice(0, outline.end).join("\n");
  const suffix = lines.slice(outline.end).join("\n");
  for (const variant of outlineTitleVariants(title).sort((a, b) => b.length - a.length)) {
    const match = flexibleTextRegex(variant).exec(suffix);
    if (!match) continue;
    const before = suffix.slice(0, match.index).replace(/\s+$/g, "");
    const after = suffix.slice(match.index).replace(/^\s+/g, "");
    const heading = `${title.startsWith("附") ? "###" : "##"} ${title}`;
    return `${prefix}${before ? `\n${before}` : ""}\n\n${heading}\n\n${after}`;
  }
  return markdown;
}

function flexibleTextRegex(text: string): RegExp {
  const pattern = Array.from(text)
    .filter((char) => !/\s/.test(char))
    .map((char) => escapeRegExp(char))
    .join("\\s*");
  return new RegExp(pattern);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitAtFirstColon(text: string): string {
  const parts = text.split(/[：:]/);
  return parts[0] ?? text;
}

function stripLeadingSectionNumber(text: string): string {
  return text
    .replace(/^\s*[第]?[一二三四五六七八九十百千\d]+[章节篇部分、.．)）\-\s]+/u, "")
    .trim();
}

function normalizeMatchText(text: string): string {
  return stripInlineMarkdown(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}
