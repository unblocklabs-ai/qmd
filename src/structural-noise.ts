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

export type StructuralNoiseSpan = { start: number; end: number; reason: string };
export type StructuralNoiseDetector = (content: string) => Iterable<StructuralNoiseSpan>;
export type StructuralNoiseOptions = {
  /** Default: true. Markdown closing-fence detection is always enabled. */
  includeDefaultNoiseDetectors?: boolean;
  extraNoiseDetectors?: readonly StructuralNoiseDetector[];
};

/** Only a recognized source-level REM heading/marker span, never arbitrary short content. */
export const OPENCLAW_REM_NOISE_DETECTOR: StructuralNoiseDetector = function* (text) {
  for (const m of text.matchAll(/^## REM Sleep\n<!-- openclaw:dreaming:rem:start -->\n/gm)) {
    yield { start: m.index, end: m.index + m[0].length, reason: "dreaming-heading-marker" };
  }
};

/** A source-aware chunk eligibility check: do not change the original Markdown or its offsets. */
export function createStructuralNoiseCheck(content: string, options?: StructuralNoiseOptions): (start: number, end: number) => string | undefined {
  const fences = codeRanges(content);
  const detectors = options?.extraNoiseDetectors ?? [];
  const spans = (options?.includeDefaultNoiseDetectors === false
    ? detectors : [OPENCLAW_REM_NOISE_DETECTOR, ...detectors])
    .flatMap(detect => Array.from(detect(content)))
    .filter(({ start, end }) => !fences.some(r => r.start < end && r.end > start));
  return (start, end) => {
    const text = content.slice(start, end);
    const span = spans.find(e => e.start <= start && e.end >= end);
    if (span && text.trim()) return span.reason;
    // Only a closing fence of a known fenced block, with substantive content elsewhere in that block.
    if (/^\s*(?:`{3,}|~{3,})\s*$/.test(text)) {
      const range = fences.find(r => r.end === end && r.closingStart === start && r.start < start);
      if (range && content.slice(range.start, start).split("\n").slice(1).join("\n").trim()) return "orphan-closing-fence";
    }
    return undefined;
  };
}
