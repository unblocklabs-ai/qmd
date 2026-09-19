import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStore, type QMDStore } from "../src/index.js";
import { openDatabase } from "../src/db.js";
import { hashContent, insertContent, insertDocument, type SearchResult } from "../src/store.js";
import { queryApiKey } from "../src/typesafe-query.js";

let store: QMDStore;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-typesafe-query-"));
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
  return Response.json({ answers: { usefulness: { type: "score", score: value, confidence: 1,
    probabilities: { "0": Number(value === 0), "1": Number(value === 1), "2": Number(value === 2), "3": Number(value === 3) } } } });
}
const typesafe = { apiKey: "test-only-key", timeoutMs: 1000 };

test("SDK query retrieves 1.5k per backend, deduplicates excerpts and uses TypeSafe rather than local models", async () => {
  const direct = await document("direct.md", "staging approved by Mira");
  const background = await document("background.md", "staging general background");
  store.internal.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)");
  const vector = vi.spyOn(store.internal, "searchVec").mockResolvedValue([background, direct]);
  const expand = vi.spyOn(store.internal, "expandQuery");
  const localRerank = vi.spyOn(store.internal, "rerank");
  const requests: Array<{ state: { timeContext: object; candidate: { excerpt: string } } }> = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return score(body.state.candidate.excerpt.includes("Mira") ? 3 : 1);
  });
  const timeContext = { sessionStartedFrom: "2026-09-01T00:00:00-04:00", sessionStartedTo: "2026-09-18T23:59:59-04:00" };
  const results = await store.search({ query: "Who approved staging?", limit: 2, minScore: 0.5,
    collection: "docs", typesafe, explain: true, timeContext });
  expect(vector.mock.calls[0]?.[2]).toBe(3);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(expand).not.toHaveBeenCalled();
  expect(localRerank).not.toHaveBeenCalled();
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ file: direct.filepath, score: 1, explain: { ranking: "typesafe", methods: ["vector", "bm25"] } });
  expect(requests[0]!.state.timeContext).toEqual({ ...timeContext, asOf: results[0]!.explain!.asOf });
  expect(requests[1]!.state.timeContext).toEqual(requests[0]!.state.timeContext);
});

test("BM25 collection and exact-path scopes apply before LIMIT; source attribution is not deduped across files", async () => {
  for (let i = 0; i < 25; i++) await document(`denied-${i}.md`, `staging staging staging ${i}`, "other");
  await document("allowed.md", "staging approved");
  await document("same.md", "staging approved");
  await document("denied.md", "staging staging staging");
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).state.candidate.sourcePath);
    return score(2);
  });
  const results = await store.search({ query: "staging", collection: "docs", limit: 1,
    allowedPaths: { docs: ["allowed.md", "same.md"] }, typesafe });
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
    requests.push(JSON.parse(String(init?.body)).state.candidate.excerpt);
    return score(3);
  });
  const plain = await store.search({ query: "staging", typesafe });
  expect(plain.find(h => h.bestChunk === chunk)?.bestChunkPos).toBe(text.indexOf(chunk));
  expect(plain).toHaveLength(2);
  requests.length = 0;
  const typed = await store.search({ queries: [{ type: "vec", query: "semantic evidence" }], typesafe });
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
])("BM25 sends the matching stored chunk to TypeSafe for $query", async ({ query, excerpt, typed }) => {
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
    sent.push(JSON.parse(String(init?.body)).state.candidate.excerpt);
    return score(3);
  });
  const options = typed ? { queries: [{ type: "lex" as const, query }] } : { query };
  const results = await store.search({ ...options, typesafe });
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
  const prefix = "Background documentation.\n".repeat(300);
  await document("unembedded.md", prefix + "Authentication is configured with OAuth.");
  const results = await store.search({ queries: [{ type: "lex", query: "auth" }], rerank: false });
  expect(results[0]?.bestChunk).toContain("Authentication");
  expect(results[0]?.bestChunkPos).toBeGreaterThan(0);
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
  await expect(store.search({ query: "staging", typesafe: { apiKey: "" } })).rejects.toThrow("requires TYPESAFE");
  expect(vector).not.toHaveBeenCalled();
  await document("match.md", "staging evidence");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ secretDiagnostic: "never include this" }));
  await expect(store.search({ query: "staging", typesafe })).rejects.toThrow("TypeSafe query scoring failed for 1 candidates");
});

test("credential files support raw and dotenv formats without fallback or environment mutation", async () => {
  const file = join(dir, "typesafe.env");
  const before = process.env.TYPESAFE_API_KEY;
  await writeFile(file, 'OTHER=ignored\nTYPESAFE_API_KEY="from-file"\n', { mode: 0o600 });
  expect(await queryApiKey({ apiKeyFile: file })).toBe("from-file");
  expect(process.env.TYPESAFE_API_KEY).toBe(before);
  await writeFile(file, "plain-key\n");
  expect(await queryApiKey({ apiKeyFile: file })).toBe("plain-key");
  await expect(queryApiKey({ apiKeyFile: join(dir, "missing") })).rejects.toThrow("credential file could not be read");
});

test("cancellation stops query and vsearch remains independent of TypeSafe", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(store.search({ query: "staging", typesafe, signal: controller.signal })).rejects.toThrow();
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
  await expect(store.search({ query: "staging", limit: 10, typesafe, signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(6);
});

test("CLI query retains its name and emits TypeSafe-scored JSON with the legacy expand prefix", async () => {
  await document("cli.md", "Mira approved staging");
  const preload = join(dir, "fetch.mjs");
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') throw Error('unexpected network');
    const body = JSON.parse(init.body);
    if (body.state.query !== 'staging' || !body.state.candidate.excerpt.includes('Mira')) throw Error('wrong state');
    return Response.json({answers:{usefulness:{type:'score',score:3,confidence:1,probabilities:{'0':0,'1':0,'2':0,'3':1}}}});
  };`);
  await writeFile(join(dir, "index.yml"), JSON.stringify({ collections: { docs: { path: dir, pattern: "**/*.md" } } }));
  const args = "Bun" in globalThis ? ["--preload", preload] : ["--import", preload, "--import", "tsx"];
  const child = spawn(process.execPath, [...args, fileURLToPath(new URL("../src/cli/qmd.ts", import.meta.url)),
    "query", "expand: staging", "--json", "--explain"], {
    env: { ...process.env, INDEX_PATH: store.dbPath, QMD_CONFIG_DIR: dir,
      TYPESAFE_API_KEY: "test-cli-key", TYPESAFE_API_KEY_FILE: "", GGML_METAL_NO_RESIDENCY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)[0]).toMatchObject({ score: 1, explain: { ranking: "typesafe", methods: ["bm25"] } });
});
