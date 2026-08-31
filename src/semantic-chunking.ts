export const SEMANTIC_CHUNKING_VERSION = 3;

const DEFAULT_MIN_TOKENS = 100;
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_SIMILARITY_WINDOW = 5;
const DEFAULT_THRESHOLD_STEP = 0.01;
const DEFAULT_THRESHOLD_TOLERANCE = 10;
const DEFAULT_EMBEDDING_BATCH_SIZE = 64;

type BoundaryKind = "none" | "section" | "event";

export type TextAtom = {
  text: string;
  start: number;
  end: number;
  tokens: number;
  boundaryBefore: BoundaryKind;
};

export type SemanticChunk = {
  text: string;
  pos: number;
  tokens: number;
};

export type SemanticChunkOptions = {
  minTokens?: number;
  maxTokens?: number;
  similarityWindow?: number;
  thresholdStep?: number;
  thresholdTolerance?: number;
  embeddingBatchSize?: number;
  embedBatch: (texts: string[]) => Promise<readonly (readonly number[])[]>;
  countTokens: (text: string) => Promise<number>;
  signal?: AbortSignal;
};

type ResolvedOptions = Required<
  Omit<SemanticChunkOptions, "embedBatch" | "countTokens" | "signal">
> & Pick<SemanticChunkOptions, "embedBatch" | "countTokens" | "signal">;

type AtomKind = "prose" | "heading" | "rule" | "fence" | "table" | "list";

type ScannedAtom = TextAtom & { kind: AtomKind };

type Line = {
  start: number;
  end: number;
  text: string;
};

type ThresholdOptions = Pick<
  ResolvedOptions,
  "minTokens" | "maxTokens" | "thresholdStep" | "thresholdTolerance"
>;

const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const RULE_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/;
const LIST_RE = /^(\s*)(?:[-+*]|\d+[.)])\s+/;
const TABLE_DELIMITER_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const TYPED_FACT_RE = /^\s*(?:[-+*]\s+)?(?:Decision|Preference|Task|Outcome|Observation)\s*:/i;
const SESSION_RE = /^\s*(?:[-+*]\s+)?(?:Session|Conversation)(?:\s+(?:ID|#))?\s*[:#]/i;
const TIMESTAMP_RE = /^\s*(?:[-+*]\s+)?(?:\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?|\[?\d{1,2}:\d{2}(?::\d{2})?\]?)(?:\s|$)/;

/**
 * The local-window similarity and dynamic-threshold algorithm is adapted from
 * Aurelio AI's MIT-licensed semantic-chunkers StatisticalChunker.
 * Copyright (c) 2024 Aurelio AI.
 * https://github.com/aurelio-labs/semantic-chunkers
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * QMD's port deliberately calculates over the complete region (embedding
 * batches are transport only) and always returns slices of the original text.
 */

function resolvedOptions(options: SemanticChunkOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    minTokens: options.minTokens ?? DEFAULT_MIN_TOKENS,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    similarityWindow: options.similarityWindow ?? DEFAULT_SIMILARITY_WINDOW,
    thresholdStep: options.thresholdStep ?? DEFAULT_THRESHOLD_STEP,
    thresholdTolerance: options.thresholdTolerance ?? DEFAULT_THRESHOLD_TOLERANCE,
    embeddingBatchSize: options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
    embedBatch: options.embedBatch,
    countTokens: options.countTokens,
    signal: options.signal,
  };

  if (resolved.minTokens < 0 || resolved.maxTokens < 1 || resolved.minTokens > resolved.maxTokens) {
    throw new RangeError("Semantic chunk token limits must satisfy 0 <= minTokens <= maxTokens");
  }
  if (resolved.similarityWindow < 1 || resolved.embeddingBatchSize < 1) {
    throw new RangeError("Semantic chunk window and embedding batch size must be positive");
  }
  if (resolved.thresholdStep <= 0 || resolved.thresholdTolerance < 0) {
    throw new RangeError("Semantic threshold step must be positive and tolerance non-negative");
  }

  return resolved;
}

function linesOf(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline + 1;
    lines.push({ start, end, text: content.slice(start, end) });
    start = end;
  }
  return lines;
}

function lineBody(line: Line): string {
  return line.text.replace(/[\r\n]+$/, "");
}

function isBlank(line: Line): boolean {
  return lineBody(line).trim().length === 0;
}

function eventMarker(line: string): boolean {
  return TYPED_FACT_RE.test(line)
    || SESSION_RE.test(line)
    || TIMESTAMP_RE.test(line);
}

function fenceEnd(lines: readonly Line[], start: number, marker: string): number {
  const closing = new RegExp(`^ {0,3}${marker[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}{${marker.length},}\\s*$`);
  for (let index = start + 1; index < lines.length; index++) {
    if (closing.test(lineBody(lines[index]!))) return index + 1;
  }
  return lines.length;
}

function tableEnd(lines: readonly Line[], start: number): number | null {
  const header = lines[start];
  const delimiter = lines[start + 1];
  if (!header || !delimiter || !lineBody(header).includes("|") || !TABLE_DELIMITER_RE.test(lineBody(delimiter))) {
    return null;
  }

  let end = start + 2;
  while (end < lines.length && !isBlank(lines[end]!) && lineBody(lines[end]!).includes("|")) end++;
  return end;
}

function startsHardBoundary(line: string): BoundaryKind {
  if (HEADING_RE.test(line) || RULE_RE.test(line)) return "section";
  return eventMarker(line) ? "event" : "none";
}

function listIndent(line: string): number | null {
  const whitespace = line.match(LIST_RE)?.[1];
  return whitespace === undefined ? null : whitespace.length;
}

function topLevelListIndent(line: string): number | null {
  const indent = listIndent(line);
  return indent !== null && indent <= 3 ? indent : null;
}

function blockKind(line: string): AtomKind {
  if (HEADING_RE.test(line)) return "heading";
  if (RULE_RE.test(line)) return "rule";
  if (topLevelListIndent(line) !== null) return "list";
  return "prose";
}

function listEntryEnd(
  lines: readonly Line[],
  start: number,
): number {
  const parentIndent = topLevelListIndent(lineBody(lines[start]!));
  if (parentIndent === null) return start + 1;

  let end = start + 1;
  while (end < lines.length) {
    if (isBlank(lines[end]!)) {
      let next = end + 1;
      while (next < lines.length && isBlank(lines[next]!)) next++;
      if (next >= lines.length) return next;

      const nextLine = lineBody(lines[next]!);
      const nextIndent = listIndent(nextLine);
      const leadingSpaces = nextLine.match(/^ */)?.[0].length ?? 0;
      if ((nextIndent !== null && nextIndent > parentIndent) || leadingSpaces > parentIndent) {
        end = next;
        continue;
      }
      return end;
    }

    const candidate = lineBody(lines[end]!);
    const candidateIndent = listIndent(candidate);
    if (startsHardBoundary(candidate) !== "none") return end;
    if (candidateIndent !== null && candidateIndent <= parentIndent) return end;
    if (FENCE_RE.test(candidate) || tableEnd(lines, end) !== null) return end;
    end++;
  }
  return end;
}

function scanMarkdownBlocks(content: string): ScannedAtom[] {
  const lines = linesOf(content);
  const atoms: ScannedAtom[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const startLine = lineIndex;
    while (lineIndex < lines.length && isBlank(lines[lineIndex]!)) lineIndex++;
    if (lineIndex >= lines.length) {
      if (atoms.length > 0) {
        const last = atoms[atoms.length - 1]!;
        last.end = content.length;
        last.text = content.slice(last.start, last.end);
      }
      break;
    }

    const meaningfulLine = lineBody(lines[lineIndex]!);
    const boundaryBefore = startsHardBoundary(meaningfulLine);
    let kind = blockKind(meaningfulLine);
    let endLine: number;
    const fence = meaningfulLine.match(FENCE_RE)?.[1];
    const table = tableEnd(lines, lineIndex);

    if (fence) {
      kind = "fence";
      endLine = fenceEnd(lines, lineIndex, fence);
    } else if (table !== null) {
      kind = "table";
      endLine = table;
    } else if (kind === "heading" || kind === "rule") {
      endLine = lineIndex + 1;
    } else if (kind === "list") {
      endLine = listEntryEnd(lines, lineIndex);
    } else {
      endLine = lineIndex + 1;
      while (endLine < lines.length && !isBlank(lines[endLine]!)) {
        const candidate = lineBody(lines[endLine]!);
        if (FENCE_RE.test(candidate) || startsHardBoundary(candidate) !== "none") break;
        if (tableEnd(lines, endLine) !== null) break;
        if (topLevelListIndent(candidate) !== null) break;
        endLine++;
      }
    }

    while (endLine < lines.length && isBlank(lines[endLine]!)) endLine++;
    const start = lines[startLine]!.start;
    const end = endLine < lines.length ? lines[endLine]!.start : content.length;
    atoms.push({
      text: content.slice(start, end),
      start,
      end,
      tokens: 0,
      boundaryBefore,
      kind,
    });
    lineIndex = endLine;
  }

  return atoms;
}

/** Scan Markdown into exact, contiguous structural atoms. */
export async function scanMarkdownAtoms(
  content: string,
  _filepath: string,
  countTokens: (text: string) => Promise<number>,
): Promise<TextAtom[]> {
  const atoms = scanMarkdownBlocks(content);
  await Promise.all(atoms.map(async atom => {
    atom.tokens = await countTokens(atom.text);
  }));
  return atoms;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error("Cannot compare embeddings with different dimensions");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function localSimilarityScores(
  vectors: readonly (readonly number[])[],
  windowSize: number,
): number[] {
  if (windowSize < 1) throw new RangeError("Similarity window must be positive");
  if (vectors.length < 2) return [];

  const scores: number[] = [];
  for (let index = 1; index < vectors.length; index++) {
    const start = Math.max(0, index - windowSize);
    const dimension = vectors[index]!.length;
    const mean = new Array<number>(dimension).fill(0);
    for (let previous = start; previous < index; previous++) {
      const vector = vectors[previous]!;
      if (vector.length !== dimension) throw new Error("All embeddings must have the same dimension");
      for (let axis = 0; axis < dimension; axis++) mean[axis]! += vector[axis]!;
    }
    const count = index - start;
    for (let axis = 0; axis < dimension; axis++) mean[axis]! /= count;
    scores.push(cosineSimilarity(mean, vectors[index]!));
  }
  return scores;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function chunkTokenCounts(scores: readonly number[], tokenCounts: readonly number[], threshold: number): number[] {
  const chunks: number[] = [];
  let current = tokenCounts[0] ?? 0;
  for (let index = 1; index < tokenCounts.length; index++) {
    if (scores[index - 1]! < threshold) {
      chunks.push(current);
      current = 0;
    }
    current += tokenCounts[index]!;
  }
  if (tokenCounts.length > 0) chunks.push(current);
  return chunks;
}

/** Find the Aurelio-style dynamic threshold for a complete semantic region. */
function findSemanticThreshold(
  scores: readonly number[],
  atomTokenCounts: readonly number[],
  options: ThresholdOptions,
): number {
  if (scores.length === 0) return 0;
  const center = median(scores);
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
  const deviation = Math.sqrt(variance);
  let low = Math.max(0, center - deviation);
  let high = Math.min(1, center + deviation);
  let threshold = (low + high) / 2;

  while (low <= high) {
    threshold = (low + high) / 2;
    const medianTokens = median(chunkTokenCounts(scores, atomTokenCounts, threshold));
    if (
      medianTokens >= options.minTokens - options.thresholdTolerance &&
      medianTokens <= options.maxTokens + options.thresholdTolerance
    ) {
      break;
    }
    if (medianTokens < options.minTokens) high = threshold - options.thresholdStep;
    else low = threshold + options.thresholdStep;
  }

  return threshold;
}

function sentenceRanges(text: string): Array<{ start: number; end: number }> {
  const segmenter = new Intl.Segmenter("und", { granularity: "sentence" });
  const starts = [...segmenter.segment(text)].map(segment => segment.index);
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? text.length }));
}

function codePointEnds(text: string): number[] {
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    offset += character.length;
    ends.push(offset);
  }
  return ends;
}

type SplitCandidate = {
  index: number;
  end: number;
  tokens: number;
};

/**
 * Find the furthest candidate that fits without probing the entire remaining
 * atom. Galloping establishes a nearby upper bound; binary search then finds
 * the exact candidate inside that bounded range.
 */
async function findBoundedSplit(
  text: string,
  relativeStart: number,
  candidates: readonly number[],
  candidateStart: number,
  options: ResolvedOptions,
): Promise<SplitCandidate | null> {
  if (candidateStart >= candidates.length) return null;

  const tokenCounts = new Map<number, number>();
  const tokensAt = async (index: number): Promise<number> => {
    const cached = tokenCounts.get(index);
    if (cached !== undefined) return cached;
    options.signal?.throwIfAborted();
    const tokens = await options.countTokens(text.slice(relativeStart, candidates[index]!));
    tokenCounts.set(index, tokens);
    return tokens;
  };

  const firstTokens = await tokensAt(candidateStart);
  if (firstTokens > options.maxTokens) return null;

  let bestIndex = candidateStart;
  let bestTokens = firstTokens;
  const lastIndex = candidates.length - 1;
  if (bestIndex === lastIndex) {
    return { index: bestIndex, end: candidates[bestIndex]!, tokens: bestTokens };
  }

  let firstTooLarge = candidates.length;
  for (let offset = 1; ; offset *= 2) {
    const probe = Math.min(candidateStart + offset, lastIndex);
    const tokens = await tokensAt(probe);
    if (tokens > options.maxTokens) {
      firstTooLarge = probe;
      break;
    }
    bestIndex = probe;
    bestTokens = tokens;
    if (probe === lastIndex) {
      return { index: bestIndex, end: candidates[bestIndex]!, tokens: bestTokens };
    }
  }

  let low = bestIndex + 1;
  let high = firstTooLarge - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const tokens = await tokensAt(middle);
    if (tokens <= options.maxTokens) {
      bestIndex = middle;
      bestTokens = tokens;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return { index: bestIndex, end: candidates[bestIndex]!, tokens: bestTokens };
}

async function forceSplitAtom(
  content: string,
  atom: ScannedAtom,
  options: ResolvedOptions,
): Promise<ScannedAtom[]> {
  const relativeLineEnds = linesOf(atom.text).map(line => line.end);
  const preserveLines = atom.kind === "fence" || atom.kind === "table";
  const lineCandidates = preserveLines && relativeLineEnds.length > 1 ? relativeLineEnds : undefined;
  let pointCandidates = lineCandidates ? undefined : codePointEnds(atom.text);
  const result: ScannedAtom[] = [];
  let relativeStart = 0;
  let lineCursor = 0;
  let pointCursor = 0;

  while (relativeStart < atom.text.length) {
    options.signal?.throwIfAborted();

    let split: SplitCandidate | null = null;
    if (lineCandidates) {
      while (lineCandidates[lineCursor] !== undefined && lineCandidates[lineCursor]! <= relativeStart) lineCursor++;
      split = await findBoundedSplit(atom.text, relativeStart, lineCandidates, lineCursor, options);
      if (split) lineCursor = split.index + 1;
    }

    if (!split) {
      pointCandidates ??= codePointEnds(atom.text);
      while (pointCandidates[pointCursor] !== undefined && pointCandidates[pointCursor]! <= relativeStart) pointCursor++;
      split = await findBoundedSplit(atom.text, relativeStart, pointCandidates, pointCursor, options);
      if (split) pointCursor = split.index + 1;
    }
    if (!split) throw new Error("Tokenizer reports a single source character above the semantic chunk limit");

    const relativeEnd = split.end;
    const start = atom.start + relativeStart;
    const end = atom.start + relativeEnd;
    const text = content.slice(start, end);
    result.push({
      text,
      start,
      end,
      tokens: split.tokens,
      boundaryBefore: result.length === 0 ? atom.boundaryBefore : "none",
      kind: atom.kind,
    });
    relativeStart = relativeEnd;
  }

  return result;
}

async function prepareAtom(content: string, atom: ScannedAtom, options: ResolvedOptions): Promise<ScannedAtom[]> {
  atom.tokens = await options.countTokens(atom.text);
  if (atom.tokens <= options.maxTokens) return [atom];

  if (atom.kind !== "fence" && atom.kind !== "table" && atom.kind !== "rule") {
    const sentences = sentenceRanges(atom.text);
    if (sentences.length > 1) {
      const split: ScannedAtom[] = [];
      for (const range of sentences) {
        const start = atom.start + range.start;
        const end = atom.start + range.end;
        const child: ScannedAtom = {
          text: content.slice(start, end),
          start,
          end,
          tokens: 0,
          boundaryBefore: split.length === 0 ? atom.boundaryBefore : "none",
          kind: atom.kind,
        };
        const prepared = await forceSplitAtom(content, child, options);
        split.push(...prepared);
      }
      return split;
    }
  }

  return forceSplitAtom(content, atom, options);
}

async function attachStructuralContext(
  content: string,
  atoms: readonly ScannedAtom[],
  options: ResolvedOptions,
): Promise<ScannedAtom[]> {
  const result: ScannedAtom[] = [];
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index]!;
    if (atom.kind !== "heading" && atom.kind !== "rule") {
      result.push(atom);
      continue;
    }

    let contentIndex = index + 1;
    while (atoms[contentIndex]?.kind === "heading" || atoms[contentIndex]?.kind === "rule") contentIndex++;
    const next = atoms[contentIndex];
    if (!next) {
      result.push(...atoms.slice(index));
      break;
    }

    const combined: ScannedAtom = {
      text: content.slice(atom.start, next.end),
      start: atom.start,
      end: next.end,
      tokens: 0,
      boundaryBefore: atom.boundaryBefore,
      kind: next.kind,
    };
    combined.tokens = await options.countTokens(combined.text);
    if (combined.tokens <= options.maxTokens) result.push(combined);
    else if (next.kind === "fence" || next.kind === "table") {
      result.push(...atoms.slice(index, contentIndex + 1));
    } else {
      result.push(...await forceSplitAtom(content, { ...combined, kind: "prose" }, options));
    }
    index = contentIndex;
  }
  return result;
}

async function embedAll(atoms: readonly TextAtom[], options: ResolvedOptions): Promise<readonly (readonly number[])[]> {
  const vectors: Array<readonly number[]> = [];
  for (let start = 0; start < atoms.length; start += options.embeddingBatchSize) {
    options.signal?.throwIfAborted();
    const batch = atoms.slice(start, start + options.embeddingBatchSize);
    const embedded = await options.embedBatch(batch.map(atom => atom.text));
    if (embedded.length !== batch.length) {
      throw new Error(`Embedding callback returned ${embedded.length} vectors for ${batch.length} atoms`);
    }
    vectors.push(...embedded);
  }
  return vectors;
}

/** Assemble one region using semantic boundaries plus an exact token ceiling. */
export async function assembleSemanticChunks(
  content: string,
  atoms: readonly TextAtom[],
  scores: readonly number[],
  threshold: number,
  options: Pick<ResolvedOptions, "minTokens" | "maxTokens" | "countTokens" | "signal">,
): Promise<SemanticChunk[]> {
  if (atoms.length === 0) return [];
  if (scores.length !== atoms.length - 1) throw new Error("Expected one similarity score between each pair of atoms");

  const chunks: SemanticChunk[] = [];
  let startIndex = 0;
  let currentTokens = atoms[0]!.tokens;

  const flush = async (endIndex: number): Promise<void> => {
    const start = atoms[startIndex]!.start;
    const end = atoms[endIndex]!.end;
    const text = content.slice(start, end);
    const tokens = await options.countTokens(text);
    if (tokens > options.maxTokens) throw new Error("Prepared semantic atoms exceeded the final token limit");
    chunks.push({ text, pos: start, tokens });
  };

  for (let index = 1; index < atoms.length; index++) {
    options.signal?.throwIfAborted();
    const candidateText = content.slice(atoms[startIndex]!.start, atoms[index]!.end);
    const candidateTokens = await options.countTokens(candidateText);
    const semanticBreak = scores[index - 1]! < threshold && currentTokens >= options.minTokens;
    if (candidateTokens > options.maxTokens || semanticBreak) {
      await flush(index - 1);
      startIndex = index;
      currentTokens = atoms[index]!.tokens;
    } else {
      currentTokens = candidateTokens;
    }
  }
  await flush(atoms.length - 1);
  return chunks;
}

async function chunkRegion(
  content: string,
  atoms: readonly ScannedAtom[],
  options: ResolvedOptions,
): Promise<SemanticChunk[]> {
  const preparedAtoms = (await Promise.all(atoms.map(atom => prepareAtom(content, atom, options)))).flat();
  const prepared = await attachStructuralContext(content, preparedAtoms, options);
  if (prepared.length === 1) {
    const only = prepared[0]!;
    return [{ text: only.text, pos: only.start, tokens: only.tokens }];
  }

  const completeStart = prepared[0]!.start;
  const completeEnd = prepared[prepared.length - 1]!.end;
  const completeText = content.slice(completeStart, completeEnd);
  const completeTokens = await options.countTokens(completeText);
  if (completeTokens <= options.minTokens) {
    return [{ text: completeText, pos: completeStart, tokens: completeTokens }];
  }

  const vectors = await embedAll(prepared, options);
  const scores = localSimilarityScores(vectors, options.similarityWindow);
  const threshold = findSemanticThreshold(scores, prepared.map(atom => atom.tokens), options);
  return assembleSemanticChunks(content, prepared, scores, threshold, options);
}

/**
 * Chunk Markdown using hard structural/event boundaries first and statistical
 * semantic boundaries inside eligible multi-atom regions.
 */
export async function chunkMarkdownSemantically(
  content: string,
  _filepath: string,
  options: SemanticChunkOptions,
): Promise<SemanticChunk[]> {
  if (content.length === 0 || content.trim().length === 0) return [];
  const resolved = resolvedOptions(options);
  resolved.signal?.throwIfAborted();
  const scanned = scanMarkdownBlocks(content);
  const regions: ScannedAtom[][] = [];
  let current: ScannedAtom[] = [];
  for (const atom of scanned) {
    const currentIsOnlyContext = current.every(item => item.kind === "heading" || item.kind === "rule");
    if (atom.boundaryBefore !== "none" && current.length > 0 && !currentIsOnlyContext) {
      regions.push(current);
      current = [];
    }
    current.push(atom);
  }
  if (current.length > 0) regions.push(current);

  const chunks: SemanticChunk[] = [];
  for (const region of regions) {
    resolved.signal?.throwIfAborted();
    chunks.push(...await chunkRegion(content, region, resolved));
  }
  return chunks;
}
