import type {
  EvaluationQuery,
  QueryMetrics,
  QueryRetrieval,
  RetrievedChunk,
  ScoredQuery,
} from "./types.js";

type OffsetSpan = { file: string; start: number; end: number; requiredAnchors: string[] };

export function lineRangeToOffsets(body: string, startLine: number, endLine: number): { start: number; end: number } {
  const starts = [0];
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "\n") starts.push(index + 1);
  }
  const start = starts[startLine - 1];
  if (start === undefined) throw new RangeError(`Line ${startLine} is outside a ${starts.length}-line document`);
  const end = starts[endLine] ?? body.length;
  return { start, end };
}

function intersectionLength(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function expectedOffsets(query: EvaluationQuery, sourceByFile: ReadonlyMap<string, string>): OffsetSpan[] {
  return query.expected.map(span => {
    const body = sourceByFile.get(span.file);
    if (body === undefined) throw new Error(`Expected file is not in corpus: ${span.file}`);
    return { file: span.file, ...lineRangeToOffsets(body, span.start_line, span.end_line), requiredAnchors: span.required_anchors ?? [] };
  });
}

function hardNegativeOffsets(query: EvaluationQuery, sourceByFile: ReadonlyMap<string, string>): OffsetSpan[] {
  return (query.hard_negatives ?? []).map(span => {
    const body = sourceByFile.get(span.file);
    if (body === undefined) throw new Error(`Hard-negative file is not in corpus: ${span.file}`);
    return { file: span.file, ...lineRangeToOffsets(body, span.start_line, span.end_line), requiredAnchors: [] };
  });
}

function matchingSpans(result: RetrievedChunk, spans: readonly OffsetSpan[]): OffsetSpan[] {
  const end = result.pos + result.length;
  return spans.filter(span => span.file === result.file && intersectionLength(result.pos, end, span.start, span.end) > 0);
}

function relevantOverlap(result: RetrievedChunk, spans: readonly OffsetSpan[]): number {
  const end = result.pos + result.length;
  return spans
    .filter(span => span.file === result.file)
    .reduce((sum, span) => sum + intersectionLength(result.pos, end, span.start, span.end), 0);
}

function gradeResult(result: RetrievedChunk, spans: readonly OffsetSpan[]): number {
  const sameFile = spans.filter(span => span.file === result.file);
  if (sameFile.length === 0) return 0;
  const matching = matchingSpans(result, sameFile);
  if (matching.length === 0) return 1;

  const anchors = matching.flatMap(span => span.requiredAnchors);
  const anchorsPresent = anchors.length === 0 || anchors.every(anchor => result.text.includes(anchor));
  const precision = relevantOverlap(result, matching) / Math.max(1, result.length);
  return anchorsPresent && precision >= 0.5 ? 3 : 2;
}

function hitAt(results: readonly RetrievedChunk[], k: number, predicate: (result: RetrievedChunk) => boolean): number {
  return results.slice(0, k).some(predicate) ? 1 : 0;
}

function dcg(gains: readonly number[]): number {
  return gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
}

function recallAtTokenBudget(results: readonly RetrievedChunk[], spans: readonly OffsetSpan[], budget: number): number {
  if (spans.length === 0) return 0;
  const found = new Set<number>();
  let tokens = 0;
  for (const result of results) {
    if (tokens + result.tokens > budget) break;
    tokens += result.tokens;
    spans.forEach((span, index) => {
      if (matchingSpans(result, [span]).length > 0) found.add(index);
    });
  }
  return found.size / spans.length;
}

export function scoreQuery(
  query: EvaluationQuery,
  retrieval: QueryRetrieval,
  sourceByFile: ReadonlyMap<string, string>,
): ScoredQuery {
  const expected = expectedOffsets(query, sourceByFile);
  const negatives = hardNegativeOffsets(query, sourceByFile);
  const fileMatches = (result: RetrievedChunk) => expected.some(span => span.file === result.file);
  const spanMatches = (result: RetrievedChunk) => matchingSpans(result, expected).length > 0;
  const gains = retrieval.results.map(result => gradeResult(result, expected));
  const firstSpan = retrieval.results.findIndex(spanMatches);
  const topFive = retrieval.results.slice(0, 5);
  const relevantChars = topFive.reduce((sum, result) => sum + relevantOverlap(result, expected), 0);
  const retrievedChars = topFive.reduce((sum, result) => sum + result.length, 0);
  const negativeHits = topFive.filter(result => matchingSpans(result, negatives).length > 0).length;
  const ideal = Array.from({ length: Math.min(5, expected.length) }, () => 3);

  const metrics: QueryMetrics = {
    fileHitAt1: hitAt(retrieval.results, 1, fileMatches),
    fileHitAt3: hitAt(retrieval.results, 3, fileMatches),
    fileHitAt5: hitAt(retrieval.results, 5, fileMatches),
    spanHitAt1: hitAt(retrieval.results, 1, spanMatches),
    spanHitAt3: hitAt(retrieval.results, 3, spanMatches),
    spanHitAt5: hitAt(retrieval.results, 5, spanMatches),
    spanMrr: firstSpan < 0 ? 0 : 1 / (firstSpan + 1),
    ndcgAt5: ideal.length === 0 ? 0 : dcg(gains.slice(0, 5)) / dcg(ideal),
    contextPrecisionAt5: retrievedChars === 0 ? 0 : relevantChars / retrievedChars,
    hardNegativeOverlapAt5: topFive.length === 0 ? 0 : negativeHits / topFive.length,
    spanRecallAt500Tokens: recallAtTokenBudget(retrieval.results, expected, 500),
    spanRecallAt1000Tokens: recallAtTokenBudget(retrieval.results, expected, 1000),
    spanRecallAt2000Tokens: recallAtTokenBudget(retrieval.results, expected, 2000),
  };

  return { ...retrieval, metrics, gains };
}

export function meanMetrics(queries: readonly ScoredQuery[]): QueryMetrics {
  const keys: Array<keyof QueryMetrics> = [
    "fileHitAt1", "fileHitAt3", "fileHitAt5", "spanHitAt1", "spanHitAt3", "spanHitAt5",
    "spanMrr", "ndcgAt5", "contextPrecisionAt5", "hardNegativeOverlapAt5",
    "spanRecallAt500Tokens", "spanRecallAt1000Tokens", "spanRecallAt2000Tokens",
  ];
  return Object.fromEntries(keys.map(key => [
    key,
    queries.length === 0 ? 0 : queries.reduce((sum, query) => sum + query.metrics[key], 0) / queries.length,
  ])) as QueryMetrics;
}
