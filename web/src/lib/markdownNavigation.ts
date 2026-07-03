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

interface OutlineCandidate {
  title: string;
  suffix: string;
  keys: string[];
}

interface OutlineTargetMatch<T> {
  target: T;
  title: string;
  suffix: string;
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
      targetIndex: index,
    }))
    .filter((heading) => heading.lineIndex >= outline.end);

  if (targets.length === 0) return markdown;

  const usedTargets = new Set<number>();
  return lines
    .map((line, index) => {
      if (index <= outline.start || index >= outline.end) return line;
      const match = /^(\s*[-*+]\s+)(.+?)\s*$/.exec(line);
      if (!match) return line;
      const [, marker, item] = match;
      if (/^\[[^\]]+\]\(#[^)]+\)/.test(item.trim())) return line;
      const matched = findOutlineTarget(item, targets, usedTargets);
      if (!matched) return line;
      if (matched.target.targetIndex !== undefined) {
        usedTargets.add(matched.target.targetIndex);
      }
      return `${marker}[${matched.title}](#${matched.target.id})${matched.suffix}`;
    })
    .join("\n");
}

function collectHeadings(lines: string[]): Array<MarkdownHeading & { lineIndex: number }> {
  const headings: Array<MarkdownHeading & { lineIndex: number }> = [];
  let inFence = false;
  lines.forEach((line, lineIndex) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
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

function findOutlineTarget<T extends { content: string; matchKey: string; targetIndex?: number }>(
  item: string,
  targets: T[],
  usedTargets?: Set<number>,
): OutlineTargetMatch<T> | null {
  for (const candidate of outlineItemCandidates(item)) {
    const itemKeys = new Set(candidate.keys);
    for (const target of targets) {
      if (target.targetIndex !== undefined && usedTargets?.has(target.targetIndex)) continue;
      if (itemKeys.has(target.matchKey)) {
        return {
          target,
          title: candidate.title,
          suffix: candidate.suffix,
        };
      }
    }
  }
  return null;
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
    const explicitLink = explicitOutlineLink(item);
    if (explicitLink) {
      if (!targets.some((target) => target.id === explicitLink.id)) {
        missing.push({ item, title: explicitLink.title });
      }
      continue;
    }
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

function outlineItemCandidates(item: string): OutlineCandidate[] {
  const plain = stripInlineMarkdown(item).trim();
  const colonIndexes = Array.from(plain.matchAll(/[：:]/g)).map((match) => match.index ?? -1);
  const candidates: Array<{ title: string; suffix: string }> = [];
  if (colonIndexes.length > 0) {
    const firstColon = colonIndexes[0];
    candidates.push({
      title: plain.slice(0, firstColon).trim(),
      suffix: normalizeSummarySuffix(plain.slice(firstColon)),
    });
    if (colonIndexes.length > 1) {
      const secondColon = colonIndexes[1];
      candidates.push({
        title: plain.slice(0, secondColon).trim(),
        suffix: normalizeSummarySuffix(plain.slice(secondColon)),
      });
    }
  }
  candidates.push({ title: outlineItemTitle(plain), suffix: summarySuffixForTitle(plain, outlineItemTitle(plain)) });
  candidates.push({ title: plain, suffix: "" });

  const seen = new Set<string>();
  return candidates
    .map(({ title, suffix }) => ({ title: title.trim(), suffix }))
    .filter(({ title }) => Boolean(title))
    .filter(({ title, suffix }) => {
      const key = `${normalizeMatchText(title)}\n${suffix}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ title, suffix }) => ({
      title,
      suffix,
      keys: outlineTitleMatchKeys(title),
    }));
}

function outlineTitleMatchKeys(title: string): string[] {
  const strippedTitle = stripLeadingSectionNumber(title);
  return Array.from(
    new Set([
      normalizeMatchText(title),
      normalizeMatchText(strippedTitle),
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

function summarySuffixForTitle(item: string, title: string): string {
  if (!title || !item.startsWith(title)) return "";
  return normalizeSummarySuffix(item.slice(title.length));
}

function normalizeSummarySuffix(suffix: string): string {
  const summary = suffix.replace(/^\s*[：:]\s*/, "").trim();
  return summary ? `：${summary}` : "";
}

function explicitOutlineLink(item: string): { title: string; id: string } | null {
  const match = /^\s*\[((?:\\.|[^\]])+)\]\(#([^)]+)\)/.exec(item.trim());
  if (!match) return null;
  return {
    title: match[1].replace(/\\(\[|\])/g, "$1").trim(),
    id: match[2].trim(),
  };
}

function outlineTitleVariants(title: string): string[] {
  const stripped = stripLeadingSectionNumber(title);
  const variants = [title, stripped];
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
