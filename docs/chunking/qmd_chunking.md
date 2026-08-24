# How QMD chunks documents

This document describes the behavior implemented in `src/` as of this checkout.
"Token" below always means the count returned by QMD's LLM tokenizer, not an
estimate, unless a passage explicitly says it is working in character space.

## The short version

QMD stores every document whole. The full body lives in the `content` table,
and full-text (BM25) search indexes those whole bodies — chunking never touches
the FTS index. Documents are split into chunks in exactly two situations:

1. **Embedding** (`qmd embed`): the document is split into overlapping,
   boundary-aware chunks, each chunk is checked against a 900-token maximum,
   embedded, and only the resulting vector plus chunk metadata (never the chunk
   text) is stored.
2. **Reranking and snippets** (`qmd query`, and structured search): each
   candidate document that survives retrieval is re-chunked on the fly, in
   character space, from its full body. One chunk is selected by simple keyword
   containment, only that chunk is sent to the LLM reranker, and its offset
   drives snippet extraction. The stored embedding chunks are *not* looked up
   for this — the two paths chunk independently.

The default strategy is **`regex`** (markdown-oriented break points), not
AST-aware chunking. `auto` is opt-in via `--chunk-strategy auto` and, for
supported code files, adds tree-sitter declaration starts as extra,
higher-quality cut candidates. The flag applies independently to embedding and
to querying.

A chunk is a plain record: `{ text, pos }`, where `pos` is the chunk's starting
offset in the original document (UTF-16 code units — JavaScript string
indexing, not bytes). The embedding chunker adds a `tokens` count. A document
that fits within the size limit becomes a single chunk with `pos: 0`.

## Data and call flow

```text
filesystem update ──> content.doc (whole document) + documents metadata
                                  │
qmd embed                         │  qmd query / structured search
  chunkDocumentByTokens()         │    hybridQuery() / structuredSearch()
  format title + chunk            │    chunkDocumentAsync() (characters)
  embedBatch()                    │    pick one chunk by keyword overlap
  content_vectors + vectors_vec   │    rerank it, extract snippet at `pos`
```

Neither vector table stores chunk text. `content_vectors` records each chunk's
`hash`, `seq`, `pos`, model, fingerprint, and `total_chunks`; `vectors_vec`
holds the embedding keyed by `hash_seq`
([`src/store.ts:4426`](../../src/store.ts#L4426)).

## The core boundary algorithm

Both paths funnel into one shared routine,
`chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars,
overlapChars, windowChars)` ([`src/store.ts:357`](../../src/store.ts#L357)).
It walks the document greedily:

1. If the whole document is at most `maxChars`, return it as one chunk.
2. Otherwise, aim for a cut at `start + maxChars` and look **backwards** up to
   `windowChars` for the best pre-scanned break point (see scoring below). If
   no usable candidate exists in that window, cut at the target position.
3. Slice the chunk, then start the next chunk at `end - overlapChars`, so
   consecutive chunks overlap. If stepping back would fail to move past the
   previous chunk's start, the next chunk starts at `end` with no overlap
   instead — forward progress always wins over overlap.
4. Repeat until the end of the document.

All offsets are UTF-16 code-unit positions. Before finalizing a cut (and again
when applying overlap), the algorithm nudges the position off the middle of a
surrogate pair so an emoji or other astral-plane character is never split in
two ([`src/store.ts:347`](../../src/store.ts#L347)).

### Break-point candidates (regex)

`scanBreakPoints()` ([`src/store.ts:181`](../../src/store.ts#L181)) scans the
document once for every pattern below. Each pattern must be preceded by a
newline (so a heading on the very first line of a document is not a
candidate), and when several patterns match the same position, the highest
score wins. The patterns and scores
([`src/store.ts:161`](../../src/store.ts#L161)):

| Candidate | Score |
|---|---:|
| H1 / H2 / H3 / H4 / H5 / H6 heading | 100 / 90 / 80 / 70 / 60 / 50 |
| Three-backtick code-fence marker | 80 |
| Horizontal rule (`---`, `***`, `___`) | 60 |
| Blank line(s) (paragraph boundary) | 20 |
| List item (ordered or unordered) | 5 |
| Any newline | 1 |

### Code fences

`findCodeFences()` ([`src/store.ts:208`](../../src/store.ts#L208)) pairs
occurrences of a newline followed by three backticks, first-to-second,
third-to-fourth, and so on; an unmatched opening fence is treated as running
to the end of the document. Candidates *strictly inside* a fence region are
rejected ([`src/store.ts:235`](../../src/store.ts#L235)), so the algorithm
avoids splitting code blocks — but two caveats keep this a preference rather
than a guarantee:

* The fence markers themselves are valid (score-80) cut points, so a chunk may
  begin or end exactly at a ` ``` ` line.
* When no eligible candidate exists in the window, the forced cut at
  `start + maxChars` can land inside a fence. Fences protect *candidates*;
  they do not override the size limit.

### Choosing among candidates

For each non-final chunk, `findBestCutoff()`
([`src/store.ts:252`](../../src/store.ts#L252)) considers candidates in
`[target - window, target]` and scores each one with a distance decay:

```text
finalScore = baseScore * (1 - (distance / window)^2 * 0.7)
```

The squared distance makes the decay gentle near the target and steep near the
window edge (a candidate at the far edge keeps 30% of its base score), so a
strong heading fairly far back still beats a mediocre break right at the
target. The highest-scoring candidate wins; on a tie, the earliest one in the
window. With no candidate at all, the cut falls at the target position.

### AST candidates (`auto` only)

With `--chunk-strategy auto` and a supported file extension,
`chunkDocumentAsync()` asks tree-sitter for declaration boundaries and merges
them with the regex candidates, keeping the higher score when both name the
same position ([`src/store.ts:3132`](../../src/store.ts#L3132),
[`src/store.ts:300`](../../src/store.ts#L300)).

Supported extensions map to TypeScript (`.ts`, `.mts`, `.cts`), TSX (`.tsx`,
`.jsx`), JavaScript (`.js`, `.mjs`, `.cjs`), Python, Go, and Rust
([`src/ast.ts:36`](../../src/ast.ts#L36)). Anything else — including
Markdown — uses regex candidates alone, and so does any failure along the way:
missing tree-sitter, a grammar that fails to load, or a parse error all return
zero AST points and degrade silently to regex behavior
([`src/ast.ts:274`](../../src/ast.ts#L274)).

Each tree-sitter query capture contributes the *start position* of the node,
scored on the same scale as the markdown patterns
([`src/ast.ts:94`](../../src/ast.ts#L94),
[`src/ast.ts:158`](../../src/ast.ts#L158)):
class/interface/struct/trait/impl/module 100; export/function/method/decorated
definition 90; type alias/enum 80; import 60. These are preferred cut *points*
fed into the same decay scoring — not a guarantee that a whole declaration
lands in one chunk. The implementation passes tree-sitter's `node.startIndex`
straight into the shared algorithm ([`src/ast.ts:305`](../../src/ast.ts#L305)),
relying on it being compatible with the UTF-16 string offsets used everywhere
else.

## The embedding path

`generateEmbeddings()` ([`src/store.ts:1962`](../../src/store.ts#L1962))
fetches documents that still need vectors, skips whitespace-only bodies,
extracts a title, and calls `chunkDocumentByTokens(body, …, path,
options?.chunkStrategy, signal)`
([`src/store.ts:2086`](../../src/store.ts#L2086)). The returned chunks are
numbered with zero-based `seq`, keep their original-document offset as `pos`,
and record the array length as the document's expected `total_chunks`
([`src/store.ts:2094`](../../src/store.ts#L2094)).

The text actually embedded is `formatDocForEmbedding(chunk.text, title,
model)` ([`src/store.ts:2029`](../../src/store.ts#L2029)) — the title is
prepended at embed time and plays no part in boundary calculation. Two
integrity guards apply:

* If some but not all chunks of a multi-chunk document fail even after
  retries, the partial set is deleted, so a document is never left looking
  fully embedded ([`src/store.ts:4452`](../../src/store.ts#L4452)).
* The embedding fingerprint hashes the chunk-size and overlap constants along
  with the model and prompt formats
  ([`src/store.ts:114`](../../src/store.ts#L114)), so changing the chunking
  constants invalidates existing embeddings rather than silently mixing
  incompatible chunk geometries.

### Token-limit enforcement

`chunkDocumentByTokens()` ([`src/store.ts:3214`](../../src/store.ts#L3214))
cannot chunk directly in tokens, so it works in two passes:

1. **Estimate pass.** Run the shared boundary algorithm in character space
   using a conservative 3-characters-per-token estimate: 2,700 / 405 / 600
   characters for the 900 / 135 / 200 token targets.
2. **Verify pass.** Tokenize every provisional chunk with the default LLM's
   tokenizer. A chunk at or under `maxTokens` is emitted as-is (its `tokens`
   metadata is this measured count). A chunk over the limit is re-chunked
   recursively with a tighter budget: `maxTokens × (its actual chars-per-token
   ratio) × 0.95` characters, with overlap and window halved. These sub-splits
   deliberately reuse regex-only `chunkDocument()`
   ([`src/store.ts:3113`](../../src/store.ts#L3113)) even when `auto` supplied
   AST candidates in the first pass.

Two fallbacks handle pathological content (for example a single enormous line
with no break points):

* If re-chunking makes no progress, the text is split in half with no overlap
  and recursion continues.
* If even that cannot split it, the chunk is truncated to its first
  `maxTokens` token IDs, detokenized, and emitted; the text beyond that point
  is dropped for this chunk (there is no continuation chunk). This is only
  reachable after both split attempts fail.

Boundary conditions worth knowing:

* A nonempty single-code-unit chunk is emitted without further splitting even
  if the tokenizer reports it as over the limit — recursion has to stop
  somewhere, and one code unit cannot be split.
* Emitted text passes through `stripUnpairedSurrogates()`
  ([`src/store.ts:3177`](../../src/store.ts#L3177)), which removes a lone
  surrogate at either edge (possible when the source document was already
  malformed, or when detokenize-truncation lands mid-character). The `tokens`
  count is measured *before* this strip, so for malformed input it can
  slightly exceed the kept text. A chunk stripped to nothing is dropped.
* Overlap is a character-space target, not a token-space postcondition:
  recursive splitting changes it, and the truncation fallback has none.
* This function tokenizes with the global default LLM
  ([`src/store.ts:3223`](../../src/store.ts#L3223)), while embedding itself
  uses the store's/session's LLM. That is simply the implemented call graph —
  in practice the two are usually the same instance.

## The search path

After FTS and vector retrieval are fused with RRF, `hybridQuery()` re-chunks
each candidate's **full body** with `chunkDocumentAsync()` using the
character-space defaults ([`src/store.ts:5599`](../../src/store.ts#L5599)). It
then picks one chunk per document by keyword containment
([`src/store.ts:5604`](../../src/store.ts#L5604)): each lowercased query term
longer than two characters found in the chunk scores 1 point, each intent term
scores 0.5, and ties go to the earliest chunk. Only that winning chunk is sent
to the reranker ([`src/store.ts:5668`](../../src/store.ts#L5668)) — reranking
full bodies is O(tokens) and was the performance lesson that motivated this
design.

The winning chunk's text and offset (`bestChunk`, `bestChunkPos`) flow to the
CLI and MCP output layers, which pass the offset and chunk length to
`extractSnippet()` to render the snippet
([`src/mcp/server.ts:381`](../../src/mcp/server.ts#L381)).

`structuredSearch()` repeats the same chunk/select/rerank pattern
([`src/store.ts:5862`](../../src/store.ts#L5862),
[`src/store.ts:5993`](../../src/store.ts#L5993)). Plain `qmd search` (BM25)
and `qmd vsearch` (vector-only) return documents directly and never enter this
chunking path.

## Defaults and modes

| Setting | Value | Where it comes from |
|---|---:|---|
| Embed chunk size | 900 tokens | `CHUNK_SIZE_TOKENS` |
| Embed overlap | 135 tokens | `floor(900 × 0.15)` (15%) |
| Boundary search window | 200 tokens | searched backwards from the target |
| Character-space defaults | 3,600 / 540 / 800 chars | 4-chars-per-token approximation |
| Token-chunker estimate pass | 2,700 / 405 / 600 chars | conservative 3-chars-per-token estimate |
| Strategy default | `regex` | `auto` must be supplied explicitly |

The constants are declared at [`src/store.ts:105`](../../src/store.ts#L105).
Both `chunkDocumentAsync()` and `chunkDocumentByTokens()` default their
strategy parameter to `regex`
([`src/store.ts:3132`](../../src/store.ts#L3132),
[`src/store.ts:3214`](../../src/store.ts#L3214)), and the CLI passes an
omitted `--chunk-strategy` through as `undefined`, landing on those defaults
([`src/cli/qmd.ts:2096`](../../src/cli/qmd.ts#L2096),
[`src/cli/qmd.ts:4633`](../../src/cli/qmd.ts#L4633)).

## Consistency caveats

**Embedding chunks and query chunks do not necessarily match.** Embedding uses
`chunkDocumentByTokens()` (2,700-character estimate pass plus token-count
enforcement and possible re-splits); query reranking uses
`chunkDocumentAsync()` with the 3,600-character defaults and no token pass.
Even with the same strategy, the two can produce different boundaries for the
same document. The README's note that `--chunk-strategy auto` "also works with
query for consistent chunk selection"
([`README.md:656`](../../README.md#L656)) is true in the sense that both paths
then use the same *kind* of AST candidates — not that query-time chunks are
identical to the embedded ones.

**The SDK comment overstates the default.** The `SearchOptions` doc comment
calls `auto` the default ([`src/index.ts:173`](../../src/index.ts#L173)), but
the SDK passes an omitted value through unchanged
([`src/index.ts:419`](../../src/index.ts#L419)), so the effective default is
`chunkDocumentAsync()`'s `regex`.

## Validation anchors

Store tests cover overlap and actual token counts
([`test/store.test.ts:689`](../../test/store.test.ts#L689)), boundary and
code-fence behavior ([`test/store.test.ts:930`](../../test/store.test.ts#L930)),
and the token-limit and surrogate guardrails
([`test/store.test.ts:4557`](../../test/store.test.ts#L4557)).
[`test/ast-chunking.test.ts`](../../test/ast-chunking.test.ts) covers AST/regex
integration, and [`test/ast.test.ts`](../../test/ast.test.ts) covers language
detection, AST query output, and graceful fallback.
