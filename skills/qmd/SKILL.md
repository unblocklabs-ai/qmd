---
name: qmd
description: Search local markdown knowledge bases, notes, docs, and wikis with QMD. Use when users ask to find notes, retrieve documents, inspect a wiki, answer from indexed markdown, or set up QMD access.
license: MIT
compatibility: Requires qmd CLI or MCP server. Install via `npm install -g github:unblocklabs-ai/qmd`.
metadata:
  author: tobi
  version: "2.2.0"
allowed-tools: Bash(qmd:*), mcp__qmd__*
---

# QMD - Query Markdown Documents

## How search works

QMD searches local markdown collections: notes, docs, wikis, transcripts, and
project knowledge bases. Use it before web search when the answer may already be
in indexed local files.

The workflow is always:

1. Search for candidate documents.
2. Retrieve the full source with `qmd get` or `qmd multi-get`.
3. Answer from retrieved text, citing paths or docids.

Do not answer from snippets alone when the user needs facts, decisions, quotes,
or nuance. Snippets are only leads.

Typical loop:

```bash
qmd search "merchant reality support interviews" -n 5
# leads: #abc123 concepts/customer-proximity.md; #def432 sources/merchant-call.md
qmd multi-get "#abc123,#def432" --format md
```

Use `qmd query` for vector + BM25 retrieval followed by TypeSafe ranking.
Plain natural-language queries use both backends without local expansion.
Add `--intent` or explicit typed variants when you have useful disambiguating
context. `query` sends selected excerpts, source paths, query and intent to
TypeSafe, using `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE` configured in the
process environment. Scope collections appropriately; never print credentials.

When reporting what you retrieved, a compact note is enough; do not paste whole
files unless needed:

```text
Retrieved:
- #abc123 concepts/customer-proximity.md
- #def432 sources/merchant-call.md
```

## Pick the right search mode

Use **BM25 lexical search** when you know exact words, titles, names, code
symbols, or rare phrases:

```bash
qmd search "cockpit OKR Goodhart" -n 10
qmd search '"AI Before Headcount"' -c concepts -n 5
```

Use **`qmd query`** for semantic + keyword recall, ranked by usefulness:

```bash
qmd query "how do we use metrics without becoming metric-driven?" -n 10
qmd query "performance" --intent "web page latency, not sports" --explain
```

Optional structured fields let you author retrieval variants:
- `intent:` disambiguates the request; it does not retrieve by itself.
- `lex:` exact terms, aliases, quoted phrases and exclusions.
- `vec:` a natural-language semantic query.
- `hyde:` a hypothetical source passage, not a factual assertion.

```bash
qmd query $'intent: web latency, not sports\nlex: "connection pool" -redis\nvec: why do connections time out under load'
```

`vsearch` remains vector-only. If TypeSafe is unavailable or local-only search
is needed, use `qmd vsearch`, `qmd search`, or explicit `query --no-rerank`.
A high usefulness score is not proof; inspect source dates and attribution.

## Retrieve sources

Search results include docids like `#abc123` and `qmd://...` paths. Fetch them:

```bash
qmd get "#abc123"
qmd get qmd://concepts/ai-before-headcount.md
qmd multi-get "#abc123,#def432" --format md
qmd multi-get 'concepts/{ai-before-headcount.md,data-informed-not-metric-driven.md}' --format md
qmd multi-get 'sources/podcast-2025-*.md' -l 80
```

Use `multi-get` when comparing several hits or gathering context across pages.

### Output is line-numbered and carries the docid — cite both

`get` and `multi-get` are **line-numbered by default** and always print the
document's `#docid` and `qmd://` path. So `get` output looks like:

```text
qmd://concepts/note.md  #abc123
---

1: # Metrics as instruments
2:
3: Treat dashboards like cockpit instruments...
```

Cite the docid and exact line numbers in your answer, and use the numbers to ask
for the next slice. Pass `--no-line-numbers` only when you need raw content to
copy verbatim (e.g. reproducing a code block).

When you need to open or edit the underlying file (e.g. hand a path to `Read`,
`Edit`, or an editor), add `--full-path`. It replaces the `qmd://` URL + docid
header with the document's on-disk path, falling back to the canonical header if
the file no longer exists on disk:

```text
$ qmd get "#abc123" --full-path
/Users/you/notes/concepts/note.md
---

1: # Metrics as instruments
```

`--full-path` works the same way on `qmd search` and `qmd query`: result paths
become the file's on-disk path — `./`-prefixed relative path when the file is
inside `$PWD`, absolute realpath otherwise — and the per-result `#docid` is
dropped because the path is the identifier. The leading `./` is intentional so
the output is unambiguously a filesystem path and cannot be mistaken for a bare
collection-relative string. Default search/query output still uses `qmd://`
URIs; only opt into `--full-path` when you specifically need a path you can hand
to a non-QMD tool.

### Read line ranges with the `:from:count` suffix — never pipe through `sed`/`head`/`tail`

`qmd get` slices files itself. Use the suffix or flags; do **not** shell out to
`sed -n`, `head`, `tail`, or `awk` to pull a line range. Piping defeats docid
resolution, virtual-path lookups, line numbering, and the header, and it is
slower and more error-prone.

The most compact form is a `:from:count` suffix right on the path or docid —
prefer it:

```bash
qmd get "#abc123:120:40"                  # 40 lines starting at line 120
qmd get qmd://concepts/note.md:200:60     # lines 200–259
qmd get "#abc123:120"                      # from line 120 to end of file
qmd get "#abc123" --from 120 -l 40         # equivalent, using flags
```

Suffix and flags:

- `<path>:<from>:<count>` — start at line `<from>`, read `<count>` lines. **Best
  for reading around a search hit.**
- `<path>:<from>` — start at `<from>`, read to end of file.
- `--from <line>` / `-l <lines>` — flag equivalents. Explicit flags override the
  suffix, so `... :5:2 -l 1` reads 1 line.
- `--no-line-numbers` — drop the `N:` prefixes (line numbers are on by default).

Wrong: `qmd get "#abc123" | sed -n '120,160p'`
Right: `qmd get "#abc123:120:40"`

Search results include a `:line` anchor on each hit — feed it straight into
`qmd get path:line:<n>` to read a window around the match (line numbers in the
output will start at `line`).

## Discover what is indexed

```bash
qmd collection list
qmd ls
qmd status
```

Add collection filters when broad searches drift into the wrong corpus:

```bash
qmd search "headcount autonomous agents" -c concepts -n 10
qmd query "merchant support product reality" -c concepts -c sources -n 10
```

Omit `-c` to search everything.

## MCP Tool: `query`

The MCP tool keeps the name `query`. Pass `query` for plain hybrid recall, or
`searches` for explicit typed variants:

```json
{
  "searches": [
    { "type": "lex", "query": "cockpit OKR Goodhart" },
    { "type": "vec", "query": "data informed not metric driven product judgment" },
    { "type": "hyde", "query": "A concept note explains that metrics are useful as instruments, but leaders should not let OKRs or dashboards replace judgment." }
  ],
  "intent": "Find the concept note about using metrics as instruments without becoming metric-driven.",
  "collections": ["concepts"],
  "limit": 10
}
```

Query types:

- `lex` — BM25 keyword search. Best for exact terms, names, titles, and code.
- `vec` — vector semantic search. Best for natural-language concepts.
- `hyde` — vector search using a hypothetical answer/document passage.

## Query craft

Good QMD searches mix three things:

1. **Title/alias anchors:** exact page titles, named entities, phrases.
2. **Semantic paraphrase:** how a human would describe the idea.
3. **Negative space:** enough intent to avoid nearby-but-wrong concepts.

Examples:

```bash
# Exact-ish title lookup
qmd search '"arm the rebels" merchants tools big companies' -c concepts

# Semantic concept lookup
qmd query $'intent: Find the customer proximity concept, not generic customer delight.\nlex: support pseudonymous merchant customer interviews\nvec: founder stays close to merchant reality through support and product use'

# Source lookup
qmd search "six-week cadence WhatsApp merchant relationships Shawn Ryan" -c sources -n 10
```

## Setup and maintenance

Only mutate indexes when the user asked for setup or maintenance. Searching and
retrieving are safe; collection/index mutation is not a casual first step.

```bash
npm install -g github:unblocklabs-ai/qmd
qmd collection add ~/notes --name notes
qmd update
qmd embed
```

Health and diagnostics:

```bash
qmd doctor
qmd status
qmd pull
```

`qmd doctor` checks config, model cache, device/GPU setup, vector fingerprints,
and common environment overrides. If a model-backed command fails, run it before
changing configuration.

## MCP setup

See `references/mcp-setup.md` for Claude Code, Claude Desktop, OpenClaw, and HTTP
server configuration.

## Pitfalls

- **Do not stop at snippets.** Fetch documents before making claims.
- **Do not slice files with `sed`/`head`/`tail`.** Use the `path:from:count`
  suffix (e.g. `qmd get "#abc123:120:40"`) or `--from`/`-l`. Output is already
  line-numbered; piping breaks docid resolution, the header, and virtual paths.
- **No automatic query expansion.** Add intent or typed variants when they
  improve recall; plain queries already search both vector and BM25.
- **Do not overuse semantic search.** If you know exact titles or terms, BM25 is
  faster and often better.
- **Do not mutate indexes casually.** `qmd collection add`, `qmd update`, and
  `qmd embed` change local state and can be expensive.
- **Model-backed commands can be environment-sensitive.** If `qmd query`,
  `qmd vsearch`, or reranking fails because local models/GPU are unavailable,
  use `qmd search` and stronger lexical/structured terms.
- **Ambiguous user wording benefits from intent.** Add `intent:` to distinguish
  the requested domain from nearby-but-wrong concepts.
- **Collection names matter.** Search `concepts` for synthesized wiki pages,
  `sources` for transcripts/raw source pages, and docs collections for code or
  project documentation.
