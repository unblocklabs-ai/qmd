# Lean semantic chunking implementation for QMD

**Status:** lean MVP implemented on 2026-08-23; representative retrieval evaluation remains pending
**Goal:** add semantic/event-aware Markdown chunking by adapting Aurelio AI's MIT-licensed `StatisticalChunker` algorithm to TypeScript, while preserving QMD's local-first architecture and current behavior by default.

## Decision

Add one opt-in strategy:

```sh
qmd embed --chunk-strategy semantic
```

`semantic`:

1. treats headings, horizontal rules, and local typed-fact/timestamp/session markers as hard boundaries;
2. does not classify whole files as journals from filenames or marker counts;
3. semantically segments only long, ambiguous prose using QMD's existing embedding model;
4. uses a minimum token target for optional similarity splits and a maximum token ceiling as the hard guardrail;
5. stores each final chunk's exact source offset and length;
6. carries a matching vector chunk through hybrid search and reranking instead of independently re-chunking that candidate.

Keep `regex` as the default for the first release. Keep `auto`'s existing AST behavior unchanged. Promotion to a default should depend on journal and conventional-document retrieval evaluation, not unit tests alone.

## Why this is the lean slice

It changes the part that determines vector quality without turning QMD into a general document-understanding framework.

Included:

- a small TypeScript implementation of statistical semantic segmentation;
- a deterministic Markdown/event atom scanner with exact UTF-16 offsets;
- one additional chunk strategy;
- one additive `chunk_len` metadata column;
- propagation of the winning vector span into reranking/snippets;
- focused unit and integration tests.

Excluded:

- Python, `semantic-chunkers`, `semantic-router`, or another runtime/model;
- an LLM-based splitter or generated chunk summaries;
- a full Markdown AST dependency;
- parent/child chunk tables, multi-granularity indexes, or neighbor expansion;
- chunk-level FTS schema changes;
- query-time semantic re-chunking;
- user-facing threshold knobs before defaults have evidence.

The excluded features can be evaluated later. None is required to prove the core hypothesis: semantic/event chunks improve source-span retrieval for both daily agent journals and long topical Markdown.

## Resulting pipeline

```text
Markdown source
  │
  ├─ scan explicit structure with exact offsets
  │    hard: headings, rules, local typed facts, timestamps, sessions
  │    candidates: paragraphs, ordinary lists, speaker turns
  │
  ├─ partition at hard boundaries
  │
  ├─ eligible multi-atom region
  │    → paragraph/sentence atoms
  │    → batch-embed atoms with QMD's current embedding model
  │    → statistical similarity boundaries
  │
  ├─ verify final chunks with QMD's actual tokenizer
  │
  └─ embed final chunks and store { seq, pos, chunk_len }

query → vector hit { file, pos, chunk_len }
      → RRF at file level (unchanged)
      → rerank exact matching source span when a vector hint exists
      → existing regex selection only for FTS-only candidates
```

Semantic-boundary embeddings are temporary. Only final chunk embeddings are stored.

## The TypeScript port

### Port only the useful algorithm

Adapt these parts of Aurelio's [`StatisticalChunker`](https://github.com/aurelio-labs/semantic-chunkers/blob/main/semantic_chunkers/chunkers/statistical.py):

1. Embed an ordered list of atomic text spans.
2. For atom `i`, average up to the previous five atom embeddings.
3. Compute cosine similarity between that local mean and atom `i`.
4. Initialize threshold bounds from `median(similarities) ± standardDeviation(similarities)`.
5. Search for a threshold whose resulting median chunk size is in the target band.
6. Split at scores below the threshold once the minimum target is met; force a split at the maximum ceiling.

Do not transliterate its framework code, plotting, Pydantic models, retry decorator, progress output, tiktoken dependency, or Python batching behavior. QMD already owns those concerns.

### Correct two upstream mismatches during adaptation

The port should intentionally differ in two places:

- **Preserve source text and offsets.** The Python library joins sentence strings with spaces. QMD must return `content.slice(start, end)` so whitespace, Markdown, citations, and UTF-16 offsets remain exact.
- **Compute globally, batch only transport.** Embed atoms in bounded batches but calculate similarities and the threshold over the full semantic region. Do not let an embedding API batch boundary change the resulting chunks.

Add an attribution comment because the source algorithm is MIT-licensed by Aurelio AI. If the translation remains substantially similar, retain the upstream copyright/license notice in the new file or the repository's third-party notices.

### Minimal pure types

The new module should need approximately these types—not a class hierarchy:

```ts
export type TextAtom = {
  text: string;
  start: number;
  end: number;
  tokens: number;
  boundaryBefore: "none" | "section" | "event";
};

export type SemanticChunk = {
  text: string;
  pos: number;
  tokens: number;
};

export type SemanticChunkOptions = {
  minTokens: number;
  maxTokens: number;
  similarityWindow: number;
  thresholdStep: number;
  thresholdTolerance: number;
  embedBatch: (texts: string[]) => Promise<readonly (readonly number[])[]>;
  countTokens: (text: string) => Promise<number>;
};
```

Prefer small pure functions:

- `scanMarkdownAtoms(content, filepath)`
- `cosineSimilarity(a, b)`
- `localSimilarityScores(vectors, windowSize)`
- `findSemanticThreshold(scores, atomTokenCounts, options)`
- `assembleSemanticChunks(content, atoms, scores, threshold, options)`
- `chunkMarkdownSemantically(content, filepath, options)`

No `any`, casting wrapper, generic encoder abstraction, or pluggable splitter framework is needed.

## Structural and event boundaries

Semantic similarity resolves ambiguous prose; it must not override stronger source signals.

### Universal Markdown boundaries

The scanner should recognize, without adding a Markdown parser dependency:

- ATX headings and horizontal rules as hard region boundaries for this iteration;
- fenced code blocks and tables as indivisible atoms unless they exceed the maximum token ceiling;
- paragraphs and ordinary top-level list items as semantic-candidate atoms, not hard boundaries;
- sentence boundaries within an oversized prose paragraph, using `Intl.Segmenter` with exact returned indices.

Headings belong to the following region as context; they should not become empty/title-only vector chunks.

### Local event markers

Do not classify a whole file as journal-like. In particular, neither a date-shaped
filename nor a global marker count changes how unrelated lines are interpreted.

Recognize these local hard event boundaries wherever they appear:

- typed facts such as `Decision:`, `Preference:`, `Task:`, `Outcome:`, and `Observation:`;
- timestamps;
- explicit session or conversation markers.

Semantic merging cannot cross those markers. Speaker labels (`User:`, `Assistant:`,
and similar) are ordinary semantic candidates rather than automatic hard boundaries;
otherwise a coherent exchange fragments into tiny chunks. Ordinary list items and
paragraphs likewise provide candidate atoms whose similarity determines whether
they merge or split.

This local treatment serves sparse journals and conventional single-topic Markdown
without separate profiles. Its deliberate MVP limitation is that two short,
unlabeled atoms can remain merged even when unrelated: there is no hard source
signal and too little local evidence for a reliable statistical boundary.

### Initial constants

Use upstream-like internal constants for the experiment:

```ts
const SEMANTIC_MIN_TOKENS = 100;
const SEMANTIC_MAX_TOKENS = 300;
const SEMANTIC_WINDOW = 5;
const SEMANTIC_THRESHOLD_STEP = 0.01;
const SEMANTIC_TOKEN_TOLERANCE = 10;
```

The minimum is a target: a low-similarity boundary is optional until the current
chunk reaches it. The maximum is a ceiling: assembly must split before exceeding
it. Hard event/section boundaries can produce smaller chunks. QMD's existing
tokenizer must provide counts; do not add `tiktoken` because its counts may
disagree with the active local embedding model.

Keep overlap at zero for semantic chunks. Retrieval-time context recovery is a later concern; duplicating text now would undermine the semantic-boundary experiment.

## QMD integration

### 1. New strategy without changing existing APIs unnecessarily

Extend:

```ts
export type ChunkStrategy = "auto" | "regex" | "semantic";
```

Do not force the existing public `chunkDocumentByTokens()` to know about an embedding session. Add a dedicated async semantic function and select it inside `generateEmbeddings()`, where an `ILLMSession` already exists:

```ts
const chunks = options?.chunkStrategy === "semantic"
  ? await chunkMarkdownSemantically(doc.body, doc.path, { ... })
  : await chunkDocumentByTokens(/* current arguments */);
```

The semantic embed callback should call the current session's `embedBatch()` with the active model. Format atoms consistently for document embeddings, without injecting a shared file title into boundary comparisons; a repeated title would artificially increase every adjacent similarity.

For supported source-code extensions, `semantic` should delegate to existing AST-aware `auto` chunking rather than sentence-segment code.

### 2. Persist the active strategy correctly

Chunking changes the vector index and therefore belongs in the embedding fingerprint. The current fingerprint records size and overlap but not the selected strategy.

For the MVP:

- persist the active embedding chunk strategy in `store_config`;
- an explicit `qmd embed --chunk-strategy semantic` updates it;
- a later `qmd embed` without the flag reuses it;
- default to `regex` only when no strategy has ever been stored;
- include strategy and a semantic algorithm version in `getEmbeddingFingerprint()`.

This prevents `status`, incremental embedding, and `doctor` from treating regex and semantic vectors as interchangeable. It also avoids requiring the flag on every subsequent update.

### 3. Store exact chunk length

Add an additive, lazily repaired column:

```sql
chunk_len INTEGER NOT NULL DEFAULT 0
```

Thread `chunk.text.length` through `ChunkItem` and `insertEmbedding()`. Return `chunkLen` beside `chunkPos` from vector search.

Length cannot be reconstructed safely from the next chunk's position because legacy regex chunks overlap. Storing it is the smallest reliable way to recover the exact text that produced a vector.

### 4. Preserve the vector span through hybrid search

`searchVec()` already returns `chunkPos`, but hybrid-query mapping currently discards it before RRF and independently re-chunks every candidate.

Add `chunkPos` and `chunkLen` to the internal vector result/hint path. Keep RRF file-level ranking unchanged. For each candidate:

- record the highest-scoring vector span seen for that file;
- when present, rerank `body.slice(chunkPos, chunkPos + chunkLen)`;
- otherwise retain the current query-term selection over regex chunks for an FTS-only candidate.

This is deliberately narrower than a canonical chunk table. It makes semantic vector retrieval and reranking consistent without redesigning FTS or result identity.

## Exact file scope

| File | Minimal change |
| --- | --- |
| `src/semantic-chunking.ts` | New atom scanner and statistical chunking functions. |
| `src/store.ts` | Add strategy value, persisted strategy resolution, semantic ingest branch, fingerprint version, `chunk_len`, and vector-span propagation. |
| `src/cli/qmd.ts` | Accept/document `semantic`; use persisted strategy when omitted. |
| `src/index.ts` | Expose the extended `ChunkStrategy`; no new public framework. |
| `test/semantic-chunking.test.ts` | Pure algorithm/scanner tests with deterministic fake embeddings and token counts. |
| `test/store.test.ts` | Focused ingest, migration, fingerprint, vector-span, and rerank integration tests. |
| `README.md` | Document the opt-in strategy, behavior, cost, and fallback. |

Avoid modifying `src/ast.ts` beyond importing its existing `detectLanguage()` if needed.

## Implementation sequence

### Milestone 1 — pure semantic chunker

Implement `src/semantic-chunking.ts` with injected token counting and embedding. No database or CLI changes.

Focused proof:

- local typed-fact, timestamp, and session events never merge across a hard boundary;
- headings and rules remain hard while ordinary lists, paragraphs, and speaker turns remain semantic candidates;
- filenames do not change boundary classification;
- related prose atoms merge and a sharp topic shift splits under controlled vectors;
- batching does not alter boundaries;
- output spans are ordered, non-overlapping, source-exact, and collectively preserve all non-discarded source text;
- fenced code/table atoms are not split unless the maximum ceiling requires it;
- all output respects the maximum token ceiling.

**Review gate:** inspect algorithm correctness and corpus fixtures before integration. Threshold math tests should use explicit vectors rather than loading a real model.

### Milestone 2 — opt-in embedding integration

Wire `semantic` into `generateEmbeddings()`, persist strategy/fingerprint, add `chunk_len`, and document the CLI.

Focused proof:

- semantic boundary embeddings and final embeddings use the configured store model/session;
- existing `regex` and `auto` output stays unchanged;
- a strategy change marks prior vectors stale and incremental runs reuse the persisted choice;
- partial semantic embedding failure retains QMD's existing all-chunks-per-document cleanup behavior;
- legacy databases lazily receive `chunk_len` without startup failure.

**Review gate:** measure chunk count, ingest time, and boundary-embedding overhead on a small journal collection and a conventional docs collection.

### Milestone 3 — exact-span reranking

Carry `chunkLen` through vector search and use the vector span in hybrid reranking/snippets.

Focused proof:

- a vector hit reranks the exact stored semantic source span;
- the best span survives vector-result file deduplication and hybrid fusion;
- an FTS-only result follows the existing fallback behavior;
- returned `bestChunkPos` and text identify the correct source line/snippet.

**Review gate:** run the representative retrieval set before considering semantic as the default.

These milestones should remain separate. Milestone 1 can be reviewed without database risk; Milestone 2 proves retrieval-unit quality and cost; Milestone 3 fixes the existing ingest/query chunk mismatch.

## Validation dataset and acceptance bar

Use a small, hand-auditable set before building a large benchmark:

- 20–30 sparse daily journal files with unrelated same-day facts;
- 10–20 long single-topic Markdown documents;
- roughly 50 queries split among exact fact, preference/decision, procedure, local explanation, and cross-paragraph questions;
- explicit source spans and same-file unrelated hard negatives.

Compare current `regex` against `semantic` under the same embedding model, candidate limits, reranker, and output limits. Record:

- source-span Recall@5/10;
- whether the returned chunk contains the answer span;
- unrelated same-file contamination rate;
- final chunk count and index bytes;
- embedding wall time, including ephemeral boundary embeddings;
- p50/p95 query latency (expected to remain nearly unchanged because semantic work is ingest-time).

The first release succeeds if journal exact-span recall/contamination improves materially and conventional Markdown does not regress, with acceptable ingest overhead. Do not promote the strategy merely because chunks look better in examples.

## Known risks and bounded responses

| Risk | Lean response |
| --- | --- |
| Boundary embeddings roughly add an ingest pass for long prose | Batch them through the existing session; skip semantic embedding for already-explicit small regions; measure before optimizing. |
| Two short unlabeled atoms merge despite a topic change | Document the limitation; explicit typed-fact, timestamp, session, heading, or rule markers remain available when a boundary must be hard. |
| Similarity threshold behaves poorly on a homogeneous section | The maximum token ceiling still bounds chunks; retain score traces in tests/debug output, not a permanent framework. |
| Tiny chunks lose context | Embed stable local labels/headings in the final embedding input and retain raw source spans; neighbor/parent expansion is the next measured feature, not part of this slice. |
| The configured model returns null for an atom | Fail the semantic chunking of that document and record it through the existing embedding failure path; never silently substitute arbitrary token chunks under the same fingerprint. |
| Index grows sharply for journals | Report chunks/document and index bytes; adjust target constants only from measured retrieval/cost results. |

## Explicit follow-ups, not MVP work

Only after this slice wins locally:

1. deterministic neighbor expansion using `seq`, `pos`, and `chunk_len`;
2. chunk-level FTS so lexical retrieval targets the same canonical spans;
3. richer local event syntax only if retrieval fixtures justify it;
4. late chunking/contextual embeddings if antecedent failures remain;
5. parent/child sections or multi-granularity routing for broad questions.

The lean implementation stops before all five.
