/** Source-aware eligibility only: never rewrite indexed Markdown or citation offsets. */
function codeRanges(text: string): { start: number; end: number; closingStart?: number }[] {
  const ranges: { start: number; end: number; closingStart?: number }[] = [];
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0]);
  let open: { start: number; char: string; length: number } | undefined;
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line[0]);
    if (!fence) continue;
    const delimiter = fence[1]!;
    if (!open) open = { start: line.index, char: delimiter[0]!, length: delimiter.length };
    else if (delimiter[0] === open.char && delimiter.length >= open.length && !fence[2]!.trim()) {
      ranges.push({ start: open.start, end: line.index + line[0].length, closingStart: line.index }); open = undefined;
    }
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

/** Only a recognized source-level REM heading/marker span, never arbitrary short content. */
function dreamingSpans(text: string, fences: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/^## REM Sleep\n<!-- openclaw:dreaming:rem:start -->\n/gm)) {
    const start = m.index, end = start + m[0].length;
    if (!fences.some(r => r.start < end && r.end > start)) spans.push({ start, end });
  }
  return spans;
}

/** A source-aware chunk eligibility check: do not change the original Markdown or its offsets. */
export function createStructuralNoiseCheck(content: string): (start: number, end: number) => string | undefined {
  const fences = codeRanges(content);
  const dreaming = dreamingSpans(content, fences);
  return (start, end) => {
    const text = content.slice(start, end);
    if (dreaming.some(e => e.start <= start && e.end >= end) && text.trim()) return "dreaming-heading-marker";
    // Only a closing fence of a known fenced block, with substantive content elsewhere in that block.
    if (/^\s*(?:`{3,}|~{3,})\s*$/.test(text)) {
      const range = fences.find(r => r.end === end && r.closingStart === start && r.start < start);
      if (range && content.slice(range.start, start).split("\n").slice(1).join("\n").trim()) return "orphan-closing-fence";
    }
    return undefined;
  };
}
