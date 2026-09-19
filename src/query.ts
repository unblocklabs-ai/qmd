import { getDefaultLlamaCpp } from "./llm.js";
import { randomUUID } from "node:crypto";
import { chunkDocumentAsync, getStoredChunkSpans, normalizeCjkForFTS, type Store, type HybridQueryOptions, type HybridQueryResult } from "./store.js";
import { judgeQueryExcerpt, queryApiKey, MAX_QUERY_EXCERPT_CHARS, QUERY_POLICY } from "./typesafe-query.js";

type RetrievalQuery = { type: "lex" | "vec" | "hyde"; query: string; expression?: string | null };
type Candidate = HybridQueryResult & { methods: Array<"vector" | "bm25">; retrievalScore: number };
const stopWords = new Set("a an and are as at be by can did do does for from how i in is it of on or that the their this to was were what when where which who why will with you".split(" "));
function queryTerms(query: string): string[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const meaningful = words.filter(word => !stopWords.has(word));
  return (meaningful.length ? meaningful : words).slice(0, 64);
}

/** Use FTS's actual matches, not a second tokenizer with different semantics.
 * CJK indexing inserts spaces. Whitespace-free offsets let us map its highlights
 * back to complete source chunks without changing the excerpt sent for scoring. */
function selectLexicalChunk(chunks: { pos: number; text: string }[], body: string,
  highlighted: string, marker: string, intent?: string): { pos: number; text: string } | undefined {
  const compactLength = (text: string) => text.replace(/\s/gu, "").length;
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (const [i, part] of highlighted.split(marker).entries()) {
    const end = offset + compactLength(part);
    if (i % 2 === 1) ranges.push({ start: offset, end });
    offset = end;
  }
  const intentTerms = queryTerms(intent ?? "");
  let sourcePos = 0, compactPos = 0;
  return chunks.map(chunk => {
    compactPos += compactLength(body.slice(sourcePos, chunk.pos));
    sourcePos = chunk.pos;
    const end = compactPos + compactLength(chunk.text);
    // A boundary cutting through a match must not outrank a chunk containing it whole.
    const matches = ranges.reduce((sum, range) => sum + Math.max(0,
      Math.min(end, range.end) - Math.max(compactPos, range.start)) / Math.max(1, range.end - range.start), 0);
    const lower = chunk.text.toLowerCase();
    const intentMatches = intentTerms.filter(term => lower.includes(term)).length;
    return { chunk, matches, intentMatches };
  }).sort((a, b) => b.matches - a.matches || b.intentMatches - a.intentMatches || a.chunk.pos - b.chunk.pos)[0]?.chunk;
}

/** Shared query implementation for CLI, MCP and SDK. vsearch does not call this. */
export async function typesafeQuery(store: Store, query: string, options: HybridQueryOptions = {},
  searches?: readonly RetrievalQuery[]): Promise<HybridQueryResult[]> {
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0;
  const candidateLimit = options.candidateLimit;
  const timeoutMs = options.typesafe?.timeoutMs ?? 10_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("query limit must be an integer from 1 to 500");
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new Error("query minScore must be from 0 to 1");
  if (candidateLimit !== undefined && (!Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 1500)) {
    throw new Error("query candidateLimit must be an integer from 1 to 1500");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("TypeSafe timeoutMs must be from 1 to 30000");
  if (!query.trim() || query.length > MAX_QUERY_EXCERPT_CHARS || (options.intent?.length ?? 0) > MAX_QUERY_EXCERPT_CHARS) {
    throw new Error("query and intent must each be at most 12000 characters; query must not be blank");
  }
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  signal.throwIfAborted();
  // Credential resolution precedes retrieval. No local-reranker fallback or guessed key.
  const apiKey = options.skipRerank ? undefined : await queryApiKey(options.typesafe);
  const from = options.timeContext?.sessionStartedFrom;
  const to = options.timeContext?.sessionStartedTo;
  if ((from !== undefined && !Number.isFinite(Date.parse(from))) ||
      (to !== undefined && !Number.isFinite(Date.parse(to))) ||
      (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to))) {
    throw new Error("query timeContext must contain valid ordered session-start dates");
  }
  const timeContext = { asOf: new Date().toISOString(),
    ...(from !== undefined ? { sessionStartedFrom: from } : {}),
    ...(to !== undefined ? { sessionStartedTo: to } : {}),
  };
  const perMethod = Math.ceil(limit * 1.5);
  const collection = options.collection;
  const collections = typeof collection === "string" ? [collection] : collection;
  const scope = JSON.stringify(options.allowedPaths ?? {});
  const terms = queryTerms(query);
  const requests: readonly RetrievalQuery[] = searches ?? [
    { type: "vec", query },
    { type: "lex", query, expression: terms.map(term => `"${normalizeCjkForFTS(term).trim()}"`).join(" OR ") },
  ];
  const candidates = new Map<string, Candidate>();
  const add = (hit: HybridQueryResult, method: "vector" | "bm25", rank: number) => {
    if (!hit.bestChunk.trim()) return;
    if (hit.bestChunk.length > MAX_QUERY_EXCERPT_CHARS) return;
    // Identical text in another source can concern a different person or project.
    const key = JSON.stringify([hit.file, hit.bestChunk.trim()]);
    const existing = candidates.get(key);
    const retrievalScore = 1 / (rank + 1);
    if (existing) {
      if (!existing.methods.includes(method)) existing.methods.push(method);
      existing.retrievalScore = Math.max(existing.retrievalScore, retrievalScore);
    } else candidates.set(key, { ...hit, methods: [method], retrievalScore });
  };
  const hasVectors = !!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'").get();
  for (const request of requests) {
    signal.throwIfAborted();
    if (request.type !== "lex") {
      if (!hasVectors) continue;
      options.hooks?.onEmbedStart?.(1);
      const start = performance.now();
      // Embeddings run sequentially, matching the native store's concurrency contract.
      const hits = await store.searchVec(request.query, (store.llm ?? getDefaultLlamaCpp()).embedModelName,
        perMethod, collection, undefined, undefined, options.trace, options.allowedPaths);
      options.hooks?.onEmbedDone?.(performance.now() - start);
      for (const [rank, hit] of hits.entries()) {
        const pos = hit.chunkPos, len = hit.chunkLen, body = hit.body ?? "";
        if (pos === undefined || len === undefined || pos < 0 || len <= 0 || pos + len > body.length) continue;
        add({ file: hit.filepath, displayPath: hit.displayPath, title: hit.title, body,
          bestChunk: body.slice(pos, pos + len), bestChunkPos: pos, score: hit.score,
          context: hit.context, docid: hit.docid }, "vector", rank);
      }
      continue;
    }
    if (!request.expression) continue;
    const marker = `qmd-match-${randomUUID()}`;
    // Scope active documents BEFORE LIMIT: unrelated collections must not starve recall.
    const rows = store.db.prepare(`SELECT d.collection, d.path, d.hash, d.title, c.doc,
        bm25(documents_fts, 1.5, 4.0, 1.0) AS rank,
        highlight(documents_fts, 2, ?, ?) AS highlighted
      FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
        JOIN content c ON c.hash = d.hash
      WHERE documents_fts MATCH ? AND d.active = 1
        AND (? IS NULL OR d.collection IN (SELECT value FROM json_each(?)))
        AND (NOT EXISTS (SELECT 1 FROM json_each(?) scope WHERE scope.key = d.collection)
          OR EXISTS (SELECT 1 FROM json_each(?) scope, json_each(scope.value) paths
            WHERE scope.key = d.collection AND paths.value = d.path))
      ORDER BY rank, d.collection, d.path LIMIT ?`).all<{
        collection: string; path: string; hash: string; title: string; doc: string; rank: number; highlighted: string;
      }>(marker, marker, request.expression, collections ? JSON.stringify(collections) : null,
        collections ? JSON.stringify(collections) : null, scope, scope, perMethod);
    for (const [rank, row] of rows.entries()) {
      signal.throwIfAborted();
      const file = `qmd://${row.collection}/${row.path}`;
      const stored = getStoredChunkSpans(store.db, row.hash)
        .filter(span => span.pos >= 0 && span.chunk_len > 0 && span.pos + span.chunk_len <= row.doc.length)
        .map(span => ({ pos: span.pos, text: row.doc.slice(span.pos, span.pos + span.chunk_len) }));
      // Newly indexed, not-yet-embedded documents still support lexical recall.
      const chunks = stored.length ? stored : await chunkDocumentAsync(row.doc,
        undefined, undefined, undefined, file, options.chunkStrategy === "semantic" ? "regex" : options.chunkStrategy);
      const selected = selectLexicalChunk(chunks, row.doc, row.highlighted, marker, options.intent);
      if (!selected) continue;
      add({ file, displayPath: `${row.collection}/${row.path}`, title: row.title, body: row.doc,
        bestChunk: selected.text, bestChunkPos: selected.pos, score: Math.abs(row.rank) / (1 + Math.abs(row.rank)),
        context: store.getContextForFile(file), docid: row.hash.slice(0, 6) }, "bm25", rank);
    }
  }
  const shortlist = [...candidates.values()].sort((a, b) => b.retrievalScore - a.retrievalScore)
    .slice(0, candidateLimit);
  let failed = 0;
  const results: HybridQueryResult[] = [];
  let next = 0;
  const started = performance.now();
  if (apiKey) options.hooks?.onRerankStart?.(shortlist.length);
  await Promise.all(Array.from({ length: Math.min(6, shortlist.length) }, async () => {
    while (next < shortlist.length) {
      signal.throwIfAborted();
      const hit = shortlist[next++]!;
      let judgment: Awaited<ReturnType<typeof judgeQueryExcerpt>> | undefined;
      if (apiKey) {
        try {
          judgment = await judgeQueryExcerpt({ query, intent: options.intent, timeContext,
            candidate: { excerpt: hit.bestChunk, sourcePath: hit.file } }, { apiKey, signal, timeoutMs });
        } catch {
          failed++;
          continue;
        }
      }
      const score = judgment ? judgment.score / 3 : hit.retrievalScore;
      const { methods, retrievalScore: _retrievalScore, ...result } = hit;
      results.push({ ...result, score, ...(options.explain ? { explain: {
        ranking: apiKey ? "typesafe" as const : "retrieval" as const,
        methods, score, asOf: timeContext.asOf,
        ...(judgment ? { confidence: judgment.confidence, probabilities: judgment.probabilities, policy: QUERY_POLICY } : {}),
      } } : {}) });
    }
  }));
  signal.throwIfAborted();
  if (apiKey) options.hooks?.onRerankDone?.(performance.now() - started);
  // Array-only CLI/SDK contract cannot reliably communicate an empty partial batch.
  // Fail explicitly rather than misrepresent provider failures as no matching memories.
  if (failed) throw new Error(`TypeSafe query scoring failed for ${failed} candidates; use vsearch for local search`);
  return results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.bestChunkPos - b.bestChunkPos)
    .filter(hit => hit.score >= minScore).slice(0, limit);
}
