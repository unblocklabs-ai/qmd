import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type PassageRef, type QMDStore, type SearchOptions } from "../src/index.js";
import { openDatabase } from "../src/db.js";
import { getEmbeddingFingerprint, hashContent, insertContent, insertDocument, type SearchResult } from "../src/store.js";

let store: QMDStore;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-decision-query-"));
  store = await createStore({ dbPath: join(dir, "index.sqlite"), config: { collections: {
    docs: { path: dir, pattern: "**/*.md" }, other: { path: dir, pattern: "**/*.md" },
  } } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

async function document(path: string, body: string, collection = "docs"): Promise<SearchResult> {
  const hash = await hashContent(body);
  const now = new Date().toISOString();
  insertContent(store.internal.db, hash, body, now);
  insertDocument(store.internal.db, collection, path, path, hash, now, now);
  return { filepath: `qmd://${collection}/${path}`, displayPath: `${collection}/${path}`, hash,
    docid: hash.slice(0, 6), title: path, collectionName: collection, modifiedAt: now,
    body, bodyLength: body.length, context: null, score: 0.9, source: "vec", chunkPos: 0, chunkLen: body.length };
}
function score(value: 0 | 1 | 2 | 3) {
  return Response.json({
    model: "liquid/d1.2-ultra-20261116",
    answers: { usefulness: { type: "score", score: value, confidence: 1,
      probabilities: { "0": Number(value === 0), "1": Number(value === 1), "2": Number(value === 2), "3": Number(value === 3) } } },
  });
}
function unwrapState(body: { state: Array<{
  timeContext: object;
  candidate: { excerpt: string; sourcePath: string };
}> }) {
  return body.state[0]!;
}
const decisionModel = { apiKey: "test-only-key", timeoutMs: 1000 };

test("SDK discovery preserves exact lane depth and scopes without expansion or remote scoring", async () => {
  for (let i = 0; i < 12; i++) await document(`allowed-${i}.md`, `discoveryneedle evidence ${i}`);
  for (let i = 0; i < 15; i++) await document(`denied-${i}.md`, `discoveryneedle ${i}`, "other");
  const fetch = vi.spyOn(globalThis, "fetch");
  const expand = vi.spyOn(store.internal, "expandQuery");
  const lexical = await store.discoverCandidates({ query: '"discoveryneedle missingword"', lane: "lex", collection: "docs", limit: 10 });
  expect(lexical).toHaveLength(10);
  expect(lexical.every(hit => hit.method === "bm25" && hit.file.startsWith("qmd://docs/"))).toBe(true);
  expect(lexical.every(hit => hit.score < 0)).toBe(true);
  const scoped = await store.discoverCandidates({ query: "discoveryneedle", lane: "lex", limit: 1,
    allowedPaths: { docs: ["allowed-11.md"], other: [] } });
  expect(scoped.map(hit => hit.file)).toEqual(["qmd://docs/allowed-11.md"]);
  store.internal.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)");
  const semantic = await document("semantic.md", "Exact semantic span");
  const vector = vi.spyOn(store.internal, "searchVec").mockResolvedValue([semantic]);
  const vectors = await store.discoverCandidates({ query: "semantic", lane: "vec", collection: "docs", limit: 10 });
  expect(vector.mock.calls[0]?.[2]).toBe(10);
  expect(vectors[0]).toMatchObject({ method: "vector", bestChunk: semantic.body, bestChunkPos: 0 });
  expect(fetch).not.toHaveBeenCalled();
  expect(expand).not.toHaveBeenCalled();
});

test("SDK discovery and search preserve the winning vector row and document occurrence", async () => {
  const prefix = "🙂 Background.\n\n";
  const bestChunk = "Staging approved 🚀.";
  const repeatedPos = prefix.length + bestChunk.length + 2;
  const body = `${prefix}${bestChunk}\n\n${bestChunk}`;
  const shared = await document("original.md", body);
  await document("nested/Alias.md", body, "other");
  const { db, llm } = store.internal;
  const model = llm!.embedModelName;
  const embedFingerprint = getEmbeddingFingerprint(model);
  const embed = vi.spyOn(llm!, "embed").mockResolvedValue({ embedding: [1, 0, 0], model });
  store.internal.ensureVecTable(3);
  const insertSpan = db.prepare(`INSERT INTO content_vectors
    (hash, seq, pos, chunk_len, model, embed_fingerprint, embedded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertVector = db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)");
  // The span does not identify the vector: the two rows share it but have different distances.
  for (const [seq, pos, embedding] of [
    [2, prefix.length, [-1, 0, 0]], [7, prefix.length, [1, 0, 0]], [8, repeatedPos, [0, 1, 0]],
  ] as const) {
    insertSpan.run(shared.hash, seq, pos, bestChunk.length, model, embedFingerprint, shared.modifiedAt);
    insertVector.run(`${shared.hash}_${seq}`, new Float32Array(embedding));
  }

  const query = "staging";
  const collection = ["other", "docs"];
  const ref: PassageRef = {
    collection: "other", path: "nested/Alias.md", docHash: shared.hash,
    chunkPos: prefix.length, chunkLen: bestChunk.length, seq: 7, embedFingerprint,
  };
  const file = "qmd://other/nested/Alias.md";
  const displayPath = "other/nested/Alias.md";
  const [raw] = await store.searchVector(query, { collection });
  expect(raw).toMatchObject({ filepath: file, displayPath, body, chunkPos: ref.chunkPos, chunkLen: ref.chunkLen });
  expect(raw?.ref).toEqual(ref);

  const [detailed] = await store.vsearch(query, { collection, expand: false });
  expect(detailed).toMatchObject({ file, displayPath, bestChunk, chunkPos: ref.chunkPos, chunkLen: ref.chunkLen });
  expect(detailed?.ref).toEqual(ref);

  const [vector] = await store.discoverCandidates({ query, lane: "vec", collection, limit: 10 });
  expect(vector).toMatchObject({ file, displayPath, body, bestChunk, bestChunkPos: prefix.length, method: "vector" });
  expect(vector?.ref).toEqual(ref);

  const lexical = await store.discoverCandidates({ query, lane: "lex", collection, limit: 10 });
  expect(lexical.map(hit => ({ file: hit.file, displayPath: hit.displayPath, ref: hit.ref }))).toEqual([
    { file: shared.filepath, displayPath: shared.displayPath,
      ref: { ...ref, collection: "docs", path: "original.md", seq: null, embedFingerprint: null } },
    { file, displayPath, ref: { ...ref, seq: null, embedFingerprint: null } },
  ]);

  const lexFirst: SearchOptions = { queries: [{ type: "lex", query }, { type: "vec", query }] };
  for (const search of [{ query }, lexFirst]) {
    const results = await store.search({ ...search, collections: collection, rerank: false, explain: true });
    const fused = results.find(hit => hit.file === file);
    expect(fused).toMatchObject({ bestChunk, bestChunkPos: prefix.length,
      explain: { methods: expect.arrayContaining(["vector", "bm25"]) } });
    expect(fused?.ref).toEqual(ref);
  }

  // When the vector finds the second occurrence, the first (retained) span is still lexical-only.
  embed.mockResolvedValueOnce({ embedding: [0, 1, 0], model });
  const fused = (await store.search({ ...lexFirst, collections: collection, rerank: false, explain: true }))
    .find(hit => hit.file === file);
  expect(fused).toMatchObject({ bestChunkPos: prefix.length,
    explain: { methods: ["bm25", "vector"] }, ref: { ...ref, seq: null, embedFingerprint: null } });
});

test("SDK query retrieves 1.5k per backend, deduplicates excerpts and uses @unblocklabs/decisions rather than local models", async () => {
  const direct = await document("direct.md", "staging approved by Mira");
  const background = await document("background.md", "staging general background");
  store.internal.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)");
  const vector = vi.spyOn(store.internal, "searchVec").mockResolvedValue([background, direct]);
  const expand = vi.spyOn(store.internal, "expandQuery");
  const localRerank = vi.spyOn(store.internal, "rerank");
  const requests: Array<{ url: string; model: string; isArrayState: boolean; state: ReturnType<typeof unwrapState> }> = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const state = unwrapState(body);
    requests.push({ url: String(url), model: body.model, isArrayState: Array.isArray(body.state), state });
    return score(state.candidate.excerpt.includes("Mira") ? 3 : 1);
  });
  const timeContext = { sessionStartedFrom: "2026-09-01T00:00:00-04:00", sessionStartedTo: "2026-09-18T23:59:59-04:00" };
  const results = await store.search({ query: "Who approved staging?", limit: 2, minScore: 0.5,
    collection: "docs", decisionModel, explain: true, timeContext });
  expect(vector.mock.calls[0]?.[2]).toBe(3);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(expand).not.toHaveBeenCalled();
  expect(localRerank).not.toHaveBeenCalled();
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    file: direct.filepath,
    score: 1,
    explain: { ranking: "decision", methods: ["vector", "bm25"], policy: "liquid/d1.2-ultra:query-v1" },
  });
  expect(requests[0]!.url).toBe("https://codex.unblocklabs.ai/v1/decisions");
  expect(requests[0]!.model).toBe("liquid/d1.2-ultra");
  expect(requests[0]!.isArrayState).toBe(true);
  expect(requests[0]!.state.timeContext).toEqual({ ...timeContext, asOf: results[0]!.explain!.asOf });
  expect(requests[1]!.state.timeContext).toEqual(requests[0]!.state.timeContext);
});

test("custom endpoint paths do not change the Decisions wire format", async () => {
  await document("custom.md", "staging approved");
  const endpoint = "https://decisions.example.test/v1/systemone";
  const requests: Array<{ url: string; model: string; state: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), model: body.model, state: body.state });
    return score(3);
  });
  const results = await store.search({
    query: "staging",
    explain: true,
    decisionModel: { ...decisionModel, endpoint },
  });
  expect(results[0]?.explain?.policy).toBe(`liquid/d1.2-ultra@${endpoint}:query-v1`);
  expect(requests).toEqual([{ url: endpoint, model: "liquid/d1.2-ultra", state: [expect.objectContaining({ query: "staging" })] }]);
});

test("BM25 collection and exact-path scopes apply before LIMIT; source attribution is not deduped across files", async () => {
  for (let i = 0; i < 25; i++) await document(`denied-${i}.md`, `staging staging staging ${i}`, "other");
  await document("allowed.md", "staging approved");
  await document("same.md", "staging approved");
  await document("denied.md", "staging staging staging");
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(unwrapState(JSON.parse(String(init?.body))).candidate.sourcePath);
    return score(2);
  });
  const results = await store.search({ query: "staging", collection: "docs", limit: 1,
    allowedPaths: { docs: ["allowed.md", "same.md"] }, decisionModel });
  expect(results).toHaveLength(1);
  expect(requests.sort()).toEqual(["qmd://docs/allowed.md", "qmd://docs/same.md"]);
});

test("both plain and typed query score the exact vector span, preserving other passages from the same source", async () => {
  const text = "keywords outside span\nExact semantic evidence\nstaging lexical evidence";
  const doc = await document("spans.md", text);
  const chunk = "Exact semantic evidence";
  store.internal.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)");
  vi.spyOn(store.internal, "searchVec").mockResolvedValue([{ ...doc, chunkPos: text.indexOf(chunk), chunkLen: chunk.length }]);
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(unwrapState(JSON.parse(String(init?.body))).candidate.excerpt);
    return score(3);
  });
  const plain = await store.search({ query: "staging", decisionModel });
  expect(plain.find(h => h.bestChunk === chunk)?.bestChunkPos).toBe(text.indexOf(chunk));
  expect(plain).toHaveLength(2);
  requests.length = 0;
  const typed = await store.search({ queries: [{ type: "vec", query: "semantic evidence" }], decisionModel });
  expect(requests).toEqual([chunk]);
  expect(typed[0]).toMatchObject({ bestChunk: chunk, bestChunkPos: text.indexOf(chunk) });
});

test("plain query preserves CJK lexical recall against the normalized FTS index", async () => {
  await document("cjk.md", "数据库连接池配置");
  const results = await store.search({ query: "连接池", rerank: false });
  expect(results.map(hit => hit.file)).toEqual(["qmd://docs/cjk.md"]);
});

test.each([
  { query: "auth", excerpt: "Authentication is configured with OAuth.", typed: true },
  { query: "run", excerpt: "Workers are running nightly ingestion.", typed: false },
  { query: "连接池", excerpt: "数据库连接池配置", typed: false },
  { query: '"connection pool" -redis', excerpt: "The connection\n  pool is healthy.", typed: true },
  { query: "cafe", excerpt: "The café opens at noon.", typed: false },
])("BM25 sends the matching stored chunk to the decision model for $query", async ({ query, excerpt, typed }) => {
  const prefix = "🙂 General project background.\n\n数据库介绍\t\n";
  const doc = await document("multi.md", prefix + excerpt);
  const insert = store.internal.db.prepare(
    "INSERT INTO content_vectors(hash,seq,pos,chunk_len,model,embedded_at) VALUES(?,?,?,?,?,?)",
  );
  // Deliberately reverse seq: selection must follow source positions, not IDs.
  insert.run(doc.hash, 1, 0, prefix.length, "test", new Date().toISOString());
  insert.run(doc.hash, 0, prefix.length, excerpt.length, "test", new Date().toISOString());
  const sent: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(unwrapState(JSON.parse(String(init?.body))).candidate.excerpt);
    return score(3);
  });
  const options = typed ? { queries: [{ type: "lex" as const, query }] } : { query };
  const results = await store.search({ ...options, decisionModel });
  expect(sent).toEqual([excerpt]);
  expect(results[0]).toMatchObject({ bestChunk: excerpt, bestChunkPos: prefix.length });
});

test("overlapping chunk boundaries prefer the whole FTS match and retain original offsets", async () => {
  const body = "🙂数据库背景\nAuthentication uses OAuth.";
  const pos = body.indexOf("Authentication");
  const doc = await document("overlap.md", body);
  const insert = store.internal.db.prepare(
    "INSERT INTO content_vectors(hash,seq,pos,chunk_len,model,embedded_at) VALUES(?,?,?,?,?,?)",
  );
  insert.run(doc.hash, 0, 0, pos + 4, "test", new Date().toISOString());
  insert.run(doc.hash, 1, pos, body.length - pos, "test", new Date().toISOString());
  const results = await store.search({ queries: [{ type: "lex", query: "auth" }], rerank: false });
  expect(results[0]).toMatchObject({ bestChunkPos: pos, bestChunk: "Authentication uses OAuth." });
});

test("unembedded lexical matches choose the matching deterministic chunk, not the introduction", async () => {
  const prefix = "🙂 Background documentation.\n".repeat(300);
  const body = prefix + "Authentication is configured with OAuth.";
  const doc = await document("unembedded.md", body);
  const identity = { collection: "docs", path: "unembedded.md", docHash: doc.hash,
    seq: null, embedFingerprint: null };
  const [raw] = await store.searchLex("auth");
  expect(raw?.ref).toEqual({ ...identity, chunkPos: 0, chunkLen: body.length });

  const results = await store.search({ queries: [{ type: "lex", query: "auth" }], rerank: false });
  const hit = results[0]!;
  expect(hit.bestChunk).toContain("Authentication");
  expect(hit.bestChunkPos).toBeGreaterThan(0);
  expect(hit.ref).toEqual({ ...identity, chunkPos: hit.bestChunkPos, chunkLen: hit.bestChunk.length });
  expect(body.slice(hit.bestChunkPos, hit.bestChunkPos + hit.bestChunk.length)).toBe(hit.bestChunk);
});

test("query lazily repairs an old index before reading chunk spans, without a prior health check", async () => {
  await store.close();
  const path = join(dir, "legacy.sqlite");
  const db = openDatabase(path);
  db.exec(`CREATE TABLE content_vectors (
    hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL, total_chunks INTEGER NOT NULL DEFAULT 1, embedded_at TEXT NOT NULL,
    PRIMARY KEY(hash,seq))`);
  db.close();
  store = await createStore({ dbPath: path, config: { collections: { docs: { path: dir, pattern: "**/*.md" } } } });
  const doc = await document("legacy.md", "Authentication is configured with OAuth.");
  store.internal.db.prepare("INSERT INTO content_vectors(hash,model,embedded_at) VALUES(?,?,?)")
    .run(doc.hash, "test", new Date().toISOString());
  expect(store.internal.db.prepare("PRAGMA table_info(content_vectors)").all<{ name: string }>()
    .map(column => column.name)).not.toContain("chunk_len");
  const results = await store.search({ queries: [{ type: "lex", query: "auth" }], rerank: false });
  expect(results[0]?.bestChunk).toBe(doc.body);
  expect(store.internal.db.prepare("SELECT chunk_len FROM content_vectors").get()).toEqual({ chunk_len: 0 });
});

test("typed lexical phrase/negation and explicit no-rerank remain local", async () => {
  await document("yes.md", "connection pool is healthy");
  await document("no.md", "connection pool redis");
  const fetch = vi.spyOn(globalThis, "fetch");
  const results = await store.search({ queries: [{ type: "lex", query: '"connection pool" -redis' }], rerank: false, explain: true });
  expect(results.map(h => h.file)).toEqual(["qmd://docs/yes.md"]);
  expect(results[0]!.explain?.ranking).toBe("retrieval");
  expect(fetch).not.toHaveBeenCalled();
});

test("missing credentials fail before retrieval; malformed provider output never becomes an empty success", async () => {
  const vector = vi.spyOn(store.internal, "searchVec");
  await expect(store.search({ query: "staging", decisionModel: { apiKey: "" } })).rejects.toThrow("requires CODEX_LB_API_KEY");
  expect(vector).not.toHaveBeenCalled();
  await document("match.md", "staging evidence");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ secretDiagnostic: "never include this" }));
  await expect(store.search({ query: "staging", decisionModel })).rejects.toThrow("Decision model query scoring failed for 1 candidates");
});

test("SDK search accepts Codex environment credentials and explicit raw or dotenv files without leaking ambient credentials to custom endpoints", async () => {
  await document("match.md", "staging evidence");
  const file = join(dir, "decisions.env");
  await writeFile(file, 'OTHER=ignored\nCODEX_LB_API_KEY="codex-from-file"\n', { mode: 0o600 });
  const inlineKey = process.env.CODEX_LB_API_KEY;
  const keyFile = process.env.CODEX_LB_API_KEY_FILE;
  const authorization: Array<string | null> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    authorization.push(new Headers(init?.headers).get("authorization"));
    return score(3);
  });
  const query = "staging";
  try {
    process.env.CODEX_LB_API_KEY = "ambient-codex-key";
    delete process.env.CODEX_LB_API_KEY_FILE;
    await store.search({ query });
    await store.search({ query, decisionModel: { apiKeyFile: file } });
    expect(process.env.CODEX_LB_API_KEY).toBe("ambient-codex-key");
    await writeFile(file, "plain-key\n");
    process.env.CODEX_LB_API_KEY_FILE = file;
    await store.search({ query, decisionModel: { endpoint: "HTTPS://CODEX.UNBLOCKLABS.AI/v1/decisions" } });

    await expect(store.search({ query, decisionModel: { endpoint: "https://decisions.example.test/v1/decisions" } }))
      .rejects.toThrow("requires an explicit decisionModel apiKey or apiKeyFile");
    await expect(store.search({ query, decisionModel: { apiKeyFile: join(dir, "missing") } }))
      .rejects.toThrow("credential file could not be read");
    await expect(store.search({ query, decisionModel: { apiKey: "inline", apiKeyFile: file } }))
      .rejects.toThrow("apiKey or apiKeyFile, not both");
    expect(authorization).toEqual(["Bearer ambient-codex-key", "Bearer codex-from-file", "Bearer plain-key"]);
  } finally {
    if (inlineKey === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = inlineKey;
    if (keyFile === undefined) delete process.env.CODEX_LB_API_KEY_FILE;
    else process.env.CODEX_LB_API_KEY_FILE = keyFile;
  }
});

test("cancellation stops query and vsearch remains independent of the decision model", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(store.search({ query: "staging", decisionModel, signal: controller.signal })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(await store.vsearch("staging", { expand: false })).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

test("query bounds concurrent API requests and stops the remaining queue on cancellation", async () => {
  for (let i = 0; i < 12; i++) await document(`${i}.md`, `staging ${i}`);
  const controller = new AbortController();
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    calls++;
    if (calls === 6) controller.abort();
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error("aborted"));
      else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  await expect(store.search({ query: "staging", limit: 10, decisionModel, signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(6);
});

test("query forwards candidate modifiedAt timestamp to decision model for freshness scoring", async () => {
  const doc = await document("fresh.md", "staging deploy policy updated");
  const seen: Array<{ excerpt: string; sourcePath: string; modifiedAt?: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { state: Array<{ candidate: { excerpt: string; sourcePath: string; modifiedAt?: string } }> };
    seen.push(body.state[0]!.candidate);
    return score(3);
  });
  const results = await store.search({ query: "staging", decisionModel });
  expect(results).toHaveLength(1);
  expect(results[0]?.modifiedAt).toBe(doc.modifiedAt);
  expect(seen).toEqual([{
    excerpt: "staging deploy policy updated",
    sourcePath: "qmd://docs/fresh.md",
    modifiedAt: doc.modifiedAt,
  }]);
});
