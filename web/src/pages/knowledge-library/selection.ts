export interface ArticleSelectionContext {
  selectedText: string;
  surroundingBefore: string;
  surroundingAfter: string;
  headingPath: string[];
  selectionStart?: number;
  selectionEnd?: number;
  selectionConfidence: "offset" | "text_only" | "none";
}

export function selectionContextFromDomSelection(root: HTMLElement | null): ArticleSelectionContext | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const selectedText = selection.toString().trim();
  if (!selectedText) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeText = beforeRange.toString();
  const fullText = root.innerText || root.textContent || "";
  const selectionStart = beforeText.length;
  const selectionEnd = selectionStart + selectedText.length;
  return {
    selectedText,
    surroundingBefore: fullText.slice(Math.max(0, selectionStart - 1200), selectionStart),
    surroundingAfter: fullText.slice(selectionEnd, Math.min(fullText.length, selectionEnd + 1200)),
    headingPath: headingPathBeforeDomSelection(root, range),
    selectionStart,
    selectionEnd,
    selectionConfidence: "offset",
  };
}

function headingPathBeforeDomSelection(root: HTMLElement, range: Range): string[] {
  const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  let stack: Array<{ level: number; text: string }> = [];
  for (const heading of headings) {
    const position = heading.compareDocumentPosition(range.startContainer);
    const isBeforeSelection = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!isBeforeSelection) continue;
    const level = Number(heading.tagName.slice(1)) || 1;
    const text = (heading.textContent || "").trim();
    if (!text) continue;
    stack = stack.filter((item) => item.level < level);
    stack.push({ level, text });
  }
  return stack.map((item) => item.text).slice(-4);
}

export function selectionContextFromOffsets(
  body: string,
  start: number,
  end: number,
): ArticleSelectionContext | null {
  if (start === end) return null;
  const selectionStart = Math.max(0, Math.min(start, end));
  const selectionEnd = Math.min(body.length, Math.max(start, end));
  const selectedText = body.slice(selectionStart, selectionEnd).trim();
  if (!selectedText) return null;
  return {
    selectedText,
    surroundingBefore: body.slice(Math.max(0, selectionStart - 1200), selectionStart),
    surroundingAfter: body.slice(selectionEnd, Math.min(body.length, selectionEnd + 1200)),
    headingPath: headingPathBefore(body.slice(0, selectionStart)),
    selectionStart,
    selectionEnd,
    selectionConfidence: "offset",
  };
}

export function selectionContextFromSelectedText(
  body: string,
  selectedText: string,
): ArticleSelectionContext | null {
  selectedText = selectedText.trim();
  if (!selectedText) return null;
  const exactStart = body.indexOf(selectedText);
  if (exactStart >= 0) {
    return selectionContextFromOffsets(body, exactStart, exactStart + selectedText.length);
  }
  return {
    selectedText,
    surroundingBefore: "",
    surroundingAfter: "",
    headingPath: [],
    selectionConfidence: "text_only",
  };
}

function headingPathBefore(markdown: string): string[] {
  let stack: Array<{ level: number; text: string }> = [];
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();
    stack = stack.filter((item) => item.level < level);
    stack.push({ level, text });
  }
  return stack.slice(-3).map((item) => item.text);
}
