# How QMD stores and maintains its index

This document describes the storage layer implemented in `src/` as of this
checkout: where the database lives, what each table holds, where vectors go,
and how the index is kept healthy over time. For how documents are split into
chunks, see [qmd_chunking.md](qmd_chunking.md).

## The short version

Everything lives in **one SQLite database file** — full-text index, vector
index, document bodies, embedding metadata, and an LLM response cache. By
default that file is `~/.cache/qmd/index.sqlite`; a project can opt into its
own `.qmd/index.sqlite` with `qmd init`. There is no external vector store:
vector search runs inside SQLite through the **sqlite-vec** extension, and
full-text search through **FTS5**.

Document bodies are content-addressed: the SHA-256 hash of the text is the
primary key, identical files share one stored copy, and the short **docid**
shown in search results is the first 6 characters of that hash
([`src/store.ts:2342`](../../src/store.ts#L2342)). Deleting a file from disk
soft-deletes its row (`active = 0`); `qmd cleanup` is what actually reclaims
space.

Collection *definitions* (which directories to index, glob patterns, update
hooks, contexts) live outside the database in a YAML config, and are mirrored
into the database on use so the index file is self-contained.

## Files and locations

| File | Purpose |
|---|---|
| `~/.cache/qmd/index.sqlite` | The default (global) index database |
| `~/.cache/qmd/<name>.sqlite` | A named index (`--index <name>`) |
| `~/.config/qmd/index.yml` | Collection/config YAML for the global index |
| `<project>/.qmd/index.yml` + `index.sqlite` | Project-local config and index (`qmd init`) |
| `*.sqlite-wal`, `*.sqlite-shm` | SQLite WAL sidecar files — normal, do not delete |

The database path comes from `getDefaultDbPath()`
([`src/store.ts:636`](../../src/store.ts#L636)): `$XDG_CACHE_HOME` is
respected, `INDEX_PATH` overrides everything (used by tests), and outside
production mode a missing explicit path is a hard error so tests can never
write to the real index. The config directory similarly respects
`$XDG_CONFIG_HOME` and `QMD_CONFIG_DIR`
([`src/collections.ts:114`](../../src/collections.ts#L114)).

**Project-local indexes.** `qmd init` creates `.qmd/index.yml` and points all
database writes at `.qmd/index.sqlite` in the project
([`src/cli/qmd.ts:439`](../../src/cli/qmd.ts#L439)). Commands find a local
config by walking upward from the current directory
([`src/collections.ts:136`](../../src/collections.ts#L136)). Because a
checked-in `.qmd/index.yml` travels with `git clone`, its `update:` hooks,
out-of-project collection paths, and custom model URIs are treated as
untrusted until the user approves them with `qmd trust`
([`src/cli/qmd.ts:895`](../../src/cli/qmd.ts#L895)).

## The SQLite runtime layer

`src/db.ts` abstracts over two drivers: `bun:sqlite` under Bun and
`better-sqlite3` under Node. Two platform details matter:

* **macOS + Bun:** Apple's system SQLite is compiled without extension
  loading, which would make sqlite-vec impossible. QMD swaps in Homebrew's
  SQLite via `Database.setCustomSQLite()` before opening anything
  ([`src/db.ts:31`](../../src/db.ts#L31)), then actually test-loads sqlite-vec
  against an in-memory database. If that fails, vector search is disabled but
  BM25 keeps working — degradation is deliberate and graceful.
* **Concurrency:** every connection is opened in WAL mode with a
  `busy_timeout` of 120 seconds (override: `QMD_SQLITE_BUSY_TIMEOUT`), so a
  `query` racing a long `embed` queues instead of throwing `SQLITE_BUSY`
  ([`src/db.ts:116`](../../src/db.ts#L116)). The initial WAL migration itself
  is retried in a loop because it needs a brief exclusive lock that the busy
  handler does not cover ([`src/db.ts:84`](../../src/db.ts#L84)).

## Schema

`initializeDatabase()` ([`src/store.ts:1181`](../../src/store.ts#L1181)) runs
on every open with `CREATE TABLE IF NOT EXISTS`, so there is no separate
migration step for the core tables.

### `content` — document bodies

```sql
content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)
```

The source of truth. `hash` is the SHA-256 of the body; inserts use
`INSERT OR IGNORE`, so two identical files (or an unchanged file re-indexed)
store one row ([`src/store.ts:2913`](../../src/store.ts#L2913)).

### `documents` — the filesystem layer

```sql
documents (id, collection, path, title, hash → content.hash,
           created_at, modified_at, active, UNIQUE(collection, path))
```

Maps a virtual path (`collection/path`, surfaced as `qmd://collection/path`)
to a content hash. `active` implements soft deletion: when a file disappears
from disk, the row is flipped to `active = 0` rather than deleted, and every
search query filters on `active = 1`. Three indexes cover the common lookups
(by collection, by hash, by path)
([`src/store.ts:1225`](../../src/store.ts#L1225)).

### `documents_fts` — full-text index

An FTS5 virtual table over `(filepath, title, body)` with the
`porter unicode61` tokenizer, keyed by `rowid = documents.id`
([`src/store.ts:1020`](../../src/store.ts#L1020)). It indexes **whole
documents** — chunking never touches FTS. Text is passed through CJK
normalization on the way in so Chinese/Japanese/Korean content tokenizes
usefully ([`src/store.ts:2918`](../../src/store.ts#L2918)).

Production indexing writes FTS rows directly (to apply that normalization),
but three triggers (`documents_ai`/`_ad`/`_au`) also mirror any direct
`documents` write into FTS as a safety net
([`src/store.ts:914`](../../src/store.ts#L914)).

### `content_vectors` — embedding metadata (no vectors, no text)

```sql
content_vectors (hash, seq, pos, model, embed_fingerprint,
                 total_chunks, embedded_at, PRIMARY KEY (hash, seq))
```

One row per embedded chunk ([`src/store.ts:1240`](../../src/store.ts#L1240)):
which chunk (`seq`), where it starts in the document (`pos`), which model and
fingerprint produced it, and how many chunks the document should have
(`total_chunks`). The chunk *text* is never stored — it can always be
re-derived from `content.doc`. Note the primary key is `(hash, seq)` without
the model: re-embedding with a different model replaces the rows rather than
accumulating per-model copies.

A covering index over `(model, embed_fingerprint, hash, total_chunks)` exists
purely for the "what still needs embedding?" aggregation — without it SQLite
built a transient index on every call, measured at ~3.3 s on an 81k-row
index ([`src/store.ts:1840`](../../src/store.ts#L1840)).

### `vectors_vec` — the vectors themselves (sqlite-vec)

Yes, the vectors live in SQLite. `vectors_vec` is a sqlite-vec `vec0` virtual
table:

```sql
CREATE VIRTUAL TABLE vectors_vec
  USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[<dims>] distance_metric=cosine)
```

It is **not** created at startup — the dimension count is only known after
the first embedding comes back from the model, so `qmd embed` creates it on
first use ([`src/store.ts:1464`](../../src/store.ts#L1464),
[`src/store.ts:1485`](../../src/store.ts#L1485)). The key is
`hash_seq = "<content-hash>_<seq>"`, tying each vector to its
`content_vectors` row. If the current model's dimensions do not match the
existing table, opening fails with an explicit "run `qmd embed -f`" error
rather than silently mixing geometries.

### Supporting tables

| Table | Contents |
|---|---|
| `llm_cache` | Cached LLM responses (query expansion, rerank scores), keyed by a SHA-256 of the request ([`src/store.ts:2646`](../../src/store.ts#L2646)) |
| `store_collections` | Mirror of the YAML collection config, synced on use so the DB is self-contained ([`src/store.ts:1423`](../../src/store.ts#L1423)) |
| `store_config` | Key-value metadata: the config hash, the CJK-rebuild version stamp |

The `llm_cache` is self-pruning: on ~1% of writes it trims itself to the
newest 1,000 entries ([`src/store.ts:2661`](../../src/store.ts#L2661)), and
`qmd update` clears it entirely.

## The indexing flow

`qmd collection add` and `qmd update` both funnel into `reindexCollection()`
([`src/store.ts:1605`](../../src/store.ts#L1605)) per collection:

1. **Scan.** fast-glob over the collection's pattern, never following
   symlinks, skipping dotfiles and a built-in exclude list (`node_modules`,
   `.git`, `.cache`, `vendor`, `dist`, `build`) plus the collection's own
   `ignore` patterns. Files that resolve outside the collection root (via
   `../` or symlinks) are refused; unreadable files are skipped and reported,
   not fatal; empty files are ignored.
2. **Diff by hash.** Each file's body is hashed. Same hash → untouched (or a
   cheap title update); new hash → the body goes into `content`, the
   `documents` row is updated in place; unknown path → new rows. FTS is
   rebuilt for every inserted/updated document with CJK normalization.
3. **Soft-delete the missing.** Any active document not seen in this scan is
   deactivated (`active = 0`) — a tombstone, not a delete.
4. **Light cleanup.** Content rows referenced by *no* document row at all are
   removed immediately; content held only by tombstones is kept until
   `qmd cleanup`.

For `qmd update`, each collection's optional `update:` hook (e.g.
`git pull --ff-only`) runs first via bash — but only when the config is
trusted ([`src/cli/qmd.ts:935`](../../src/cli/qmd.ts#L935)).

Embeddings are *not* produced here. Indexing only makes documents visible to
BM25; `qmd embed` fills in the vectors afterwards.

## The embedding flow (storage side)

"Needs embedding" is computed, not flagged: a document is pending when no
`content_vectors` rows exist for the current `(model, fingerprint)` pair, or
fewer rows exist than `total_chunks` promised
([`src/store.ts:1885`](../../src/store.ts#L1885)). The fingerprint hashes the
model name, the prompt formats, and the chunking constants
([`src/store.ts:114`](../../src/store.ts#L114)) — so changing any of those
automatically re-queues everything without a manual flag.

Pending documents are batched (default 64 docs / 64 MB per batch) and each
chunk is written with `insertEmbedding()`
([`src/store.ts:4426`](../../src/store.ts#L4426)): the `content_vectors`
metadata row first, then the vector into `vectors_vec` — in that order
deliberately, so a crash between the two leaves a row that the pending query
counts as incomplete rather than a vector with no metadata. If some chunks of
a multi-chunk document still fail after retries, the whole partial set is
deleted so the document stays queued
([`src/store.ts:4452`](../../src/store.ts#L4452)).

## How search reads the storage

* **BM25** (`qmd search`): a CTE forces the FTS5 match to run first with
  column weights `filepath 1.5, title 4.0, body 1.0`, then joins back to
  `documents`/`content` and filters `active = 1`
  ([`src/store.ts:4053`](../../src/store.ts#L4053)). The CTE exists because
  letting the planner combine MATCH with the collection filter can abandon
  the FTS index entirely (8 ms → 17 s).
* **Vector** (`qmd vsearch`, and the vector half of `qmd query`): a strict
  two-step — query `vectors_vec` alone, then look up the matched `hash_seq`
  rows in a second query. sqlite-vec virtual tables hang when JOINed
  directly; the comment at
  [`src/store.ts:4210`](../../src/store.ts#L4210) warns against "optimizing"
  this. Collection-scoped searches exact-scan the collection's vectors when
  it has ≤ 20,000 chunks, and only fall back to a global ANN query with
  over-fetch (sqlite-vec caps `k` at 4096) for larger ones — otherwise small
  collections never surface in the global top-k. Inactive documents are
  filtered in the second step, so tombstoned vectors are invisible even
  before cleanup removes them.

## Maintenance

### `qmd cleanup`

The full sequence ([`src/store.ts:2853`](../../src/store.ts#L2853)), also
available as a dry-run preview:

1. Delete the LLM cache.
2. Delete **orphaned vectors** — `content_vectors` + `vectors_vec` rows whose
   hash no longer belongs to any active document. The count and both deletes
   share one `BEGIN IMMEDIATE` transaction: interrupting between the two
   deletes would desync the tables in a way that later silently skips
   re-embedding if the same content ever returns
   ([`src/store.ts:2746`](../../src/store.ts#L2746)).
3. Hard-delete inactive document rows (the tombstones).
4. Delete content rows those tombstones were pinning.
5. `INSERT INTO documents_fts(documents_fts) VALUES('optimize')` — FTS5 keeps
   deleted rows in its own b-trees and `VACUUM` alone does not compact them.
6. `VACUUM` to return the freed pages.

`qmd status` and `qmd doctor` surface the pressure that makes this worth
running: pending-embedding counts, whether the vector table exists, and a
hint when orphaned vectors exceed a share of the index.

### Self-healing schema (no migration files)

There is no numbered-migration system; the schema repairs itself along four
paths, all safe under concurrent processes:

* **Lazy column migration.** Older databases predate several
  `content_vectors` columns. Any vector operation that fails with a
  missing-column error triggers an idempotent `ALTER TABLE` repair series and
  retries once ([`src/store.ts:1870`](../../src/store.ts#L1870)) — startup
  never pays for schema probes.
* **Trigger install gated by `PRAGMA user_version`.** The FTS sync triggers
  use DROP+CREATE (so updated bodies propagate), wrapped in one
  `BEGIN IMMEDIATE` transaction with a double-checked version read so two
  cold-opening processes cannot interleave the pair
  ([`src/store.ts:914`](../../src/store.ts#L914)).
* **Legacy FTS repair.** A pre-2.x `documents_fts` built as an
  external-content table is detected by inspecting its live schema and
  rebuilt as the current standalone table
  ([`src/store.ts:1048`](../../src/store.ts#L1048)).
* **One-time CJK rebuild.** When the normalization version changes, the FTS
  index is rebuilt into a per-process shadow table streamed in 500-row
  batches, then atomically swapped into place under `BEGIN IMMEDIATE` with a
  version stamp in `store_config`; losers of the race just drop their private
  shadow ([`src/store.ts:1085`](../../src/store.ts#L1085)).

Even table creation is hardened: FTS5's `CREATE VIRTUAL TABLE IF NOT EXISTS`
is not atomic across WAL connections, so a concurrent "already exists" error
is treated as success when the table is verifiably present
([`src/store.ts:1027`](../../src/store.ts#L1027)).

## Lifecycle summary

| Event | What happens in storage |
|---|---|
| File added | Body → `content` (deduped by hash), row → `documents`, FTS row written |
| File edited | New `content` row, `documents.hash` repointed, FTS rebuilt; old embedding rows no longer match the new hash, so the doc re-queues for embedding |
| File deleted | `documents.active = 0`; body, FTS cleanup via trigger, vectors linger until `qmd cleanup` |
| `qmd embed` | Chunk metadata → `content_vectors`, vectors → `vectors_vec` (created on first embed) |
| Model/chunking change | Fingerprint changes → everything re-queues; dimension change → explicit `qmd embed -f` error |
| `qmd update` | Trust check → hooks → re-scan every collection → LLM cache cleared |
| `qmd cleanup` | Cache, orphaned vectors, tombstones, orphaned content, FTS optimize, VACUUM |
