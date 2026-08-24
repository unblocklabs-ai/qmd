import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createStore } from "../../index.js";
import { vectorSearchQuery, type ChunkStrategy } from "../../store.js";
import { buildChunkReviewArtifacts, buildReviewArtifacts } from "./review.js";
import { buildObjectiveReport } from "./report.js";
import { meanMetrics, scoreQuery } from "./score.js";
import {
  CHUNKING_ARMS,
  corpusSchema,
  queryFixtureSchema,
  type ArmEvaluation,
  type ChunkingArm,
  type CorpusManifest,
  type IndexedChunk,
  type QueryFixture,
  type QueryRetrieval,
  type RetrievedChunk,
} from "./types.js";

type ResolvedCorpus = CorpusManifest & {
  root: string;
  collection: string;
  hashes: Record<string, string>;
  sourceByFile: Map<string, string>;
};

export type RunEvaluationOptions = {
  corpusPath: string;
  queriesPath: string;
  outputDir?: string;
  limit?: number;
};

const ARM_STRATEGIES: Record<ChunkingArm, ChunkStrategy> = {
  regex: "regex",
  "semantic-v2": "semantic",
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function resolveCorpus(manifestPath: string): ResolvedCorpus {
  const manifest = corpusSchema.parse(readJson(manifestPath));
  const rawRoot = isAbsolute(manifest.root) ? manifest.root : resolve(dirname(manifestPath), manifest.root);
  const root = realpathSync(rawRoot);
  const sourceByFile = new Map<string, string>();
  const hashes: Record<string, string> = {};

  for (const file of manifest.files) {
    if (isAbsolute(file)) throw new Error(`Corpus file must be relative: ${file}`);
    const candidate = resolve(root, file);
    if (!existsSync(candidate)) throw new Error(`Corpus file does not exist: ${file}`);
    const actual = realpathSync(candidate);
    const fromRoot = relative(root, actual);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`Corpus file escapes root: ${file}`);
    if (sourceByFile.has(file)) throw new Error(`Duplicate corpus file: ${file}`);
    const body = readFileSync(actual, "utf8");
    sourceByFile.set(file, body);
    hashes[file] = sha256(body);
  }

  return {
    ...manifest,
    root,
    collection: manifest.collection ?? `chunking-${manifest.id}`,
    hashes,
    sourceByFile,
  };
}

function loadQueries(path: string, corpus: ResolvedCorpus): QueryFixture {
  const fixture = queryFixtureSchema.parse(readJson(path));
  if (fixture.corpus !== corpus.id) {
    throw new Error(`Query fixture targets corpus ${fixture.corpus}, not ${corpus.id}`);
  }
  const ids = new Set<string>();
  for (const query of fixture.queries) {
    if (ids.has(query.id)) throw new Error(`Duplicate query id: ${query.id}`);
    ids.add(query.id);
    for (const span of [...query.expected, ...(query.hard_negatives ?? [])]) {
      if (!corpus.sourceByFile.has(span.file)) throw new Error(`Query ${query.id} references a file outside the corpus: ${span.file}`);
    }
  }
  return fixture;
}

function sourceLineStarts(body: string): number[] {
  const starts = [0];
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function lineRange(
  body: string,
  pos: number,
  length: number,
  starts = sourceLineStarts(body),
): { startLine: number; endLine: number } {
  return {
    startLine: lineAt(starts, pos),
    endLine: lineAt(starts, pos + Math.max(0, length - 1)),
  };
}

async function exportChunks(
  arm: ChunkingArm,
  store: Awaited<ReturnType<typeof createStore>>,
  collection: string,
): Promise<IndexedChunk[]> {
  const documents = store.internal.db.prepare(`
    SELECT d.hash, d.path AS file, d.title, c.doc AS body
    FROM documents d
    JOIN content c ON c.hash = d.hash
    WHERE d.collection = ? AND d.active = 1
  `).all(collection) as Array<{
    hash: string;
    file: string;
    title: string;
    body: string;
  }>;
  const documentByHash = new Map(documents.map(document => [document.hash, {
    ...document,
    lineStarts: sourceLineStarts(document.body),
  }]));
  const rows = store.internal.db.prepare(`
    SELECT cv.hash, cv.seq, cv.pos, cv.chunk_len AS length
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    WHERE d.collection = ?
    ORDER BY d.path, cv.seq
  `).all(collection) as Array<{
    hash: string;
    seq: number;
    pos: number;
    length: number;
  }>;
  const llm = store.internal.llm;
  if (!llm) throw new Error("Evaluator store has no tokenizer");
  const chunks: IndexedChunk[] = [];
  for (const row of rows) {
    const document = documentByHash.get(row.hash);
    if (!document) throw new Error(`Embedded chunk references an inactive document hash: ${row.hash}`);
    const text = document.body.slice(row.pos, row.pos + row.length);
    const lines = lineRange(document.body, row.pos, row.length, document.lineStarts);
    chunks.push({
      arm,
      file: document.file,
      title: document.title,
      seq: row.seq,
      pos: row.pos,
      length: row.length,
      ...lines,
      tokens: (await llm.tokenize(text)).length,
      text,
    });
  }
  return chunks;
}

async function retrieveQueries(
  store: Awaited<ReturnType<typeof createStore>>,
  fixture: QueryFixture,
  corpus: ResolvedCorpus,
  chunks: readonly IndexedChunk[],
  limit: number,
): Promise<QueryRetrieval[]> {
  const tokensBySpan = new Map(chunks.map(chunk => [`${chunk.file}:${chunk.pos}:${chunk.length}`, chunk.tokens]));
  await vectorSearchQuery(store.internal, "__qmd_chunking_eval_warmup__", {
    collection: corpus.collection,
    limit: 1,
    minScore: 0,
    expand: false,
  });
  const retrievals: QueryRetrieval[] = [];
  for (const query of fixture.queries) {
    const start = performance.now();
    const results = await vectorSearchQuery(store.internal, query.query, {
      collection: corpus.collection,
      limit,
      minScore: 0,
      expand: false,
    });
    const latencyMs = performance.now() - start;
    const mapped: RetrievedChunk[] = results.map((result, index) => {
      const prefix = `${corpus.collection}/`;
      const file = result.displayPath.startsWith(prefix) ? result.displayPath.slice(prefix.length) : result.displayPath;
      const source = corpus.sourceByFile.get(file);
      if (source === undefined) throw new Error(`Retrieved file is not in corpus: ${result.displayPath}`);
      const lines = lineRange(source, result.chunkPos, result.chunkLen);
      return {
        rank: index + 1,
        file,
        title: result.title,
        score: result.score,
        pos: result.chunkPos,
        length: result.chunkLen,
        ...lines,
        tokens: tokensBySpan.get(`${file}:${result.chunkPos}:${result.chunkLen}`) ?? 0,
        text: result.bestChunk,
      };
    });
    retrievals.push({ queryId: query.id, query: query.query, latencyMs, results: mapped });
  }
  return retrievals;
}

function jsonLines(values: readonly unknown[]): string {
  return `${values.map(value => JSON.stringify(value)).join("\n")}\n`;
}

function defaultRunDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(".qmd-evals", "runs", stamp);
}

export async function runChunkingEvaluation(options: RunEvaluationOptions): Promise<string> {
  const corpusPath = resolve(options.corpusPath);
  const queriesPath = resolve(options.queriesPath);
  const corpus = resolveCorpus(corpusPath);
  const fixture = loadQueries(queriesPath, corpus);
  const runDir = resolve(options.outputDir ?? defaultRunDir());
  if (existsSync(runDir)) throw new Error(`Run directory already exists: ${runDir}`);
  mkdirSync(join(runDir, "indexes"), { recursive: true });
  mkdirSync(join(runDir, "chunks"));
  mkdirSync(join(runDir, "retrieval"));
  mkdirSync(join(runDir, "reviews"));

  const chunksByArm = new Map<ChunkingArm, IndexedChunk[]>();
  const evaluations: ArmEvaluation[] = [];
  const limit = options.limit ?? 10;

  for (const arm of CHUNKING_ARMS) {
    process.stderr.write(`Building ${arm} index...\n`);
    const dbPath = join(runDir, "indexes", `${arm}.sqlite`);
    const store = await createStore({
      dbPath,
      config: {
        collections: {
          [corpus.collection]: {
            path: corpus.root,
            pattern: corpus.files.join(","),
            includeByDefault: true,
          },
        },
      },
    });
    let chunks: IndexedChunk[];
    let evaluation: ArmEvaluation;
    try {
      const update = await store.update();
      if (update.indexed !== corpus.files.length) {
        throw new Error(`${arm} indexed ${update.indexed} files; expected ${corpus.files.length}`);
      }
      const embedded = await store.embed({ force: true, chunkStrategy: ARM_STRATEGIES[arm] });
      if (embedded.errors > 0) throw new Error(`${arm} embedding failed for ${embedded.errors} chunks`);
      chunks = await exportChunks(arm, store, corpus.collection);
      const retrievals = await retrieveQueries(store, fixture, corpus, chunks, limit);
      const queries = fixture.queries.map(query => {
        const retrieval = retrievals.find(candidate => candidate.queryId === query.id);
        if (!retrieval) throw new Error(`Missing retrieval for query ${query.id}`);
        return scoreQuery(query, retrieval, corpus.sourceByFile);
      });
      evaluation = {
        arm,
        chunkCount: chunks.length,
        embeddedTokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
        indexBytes: 0,
        ingestDurationMs: embedded.durationMs,
        meanQueryLatencyMs: queries.reduce((sum, query) => sum + query.latencyMs, 0) / queries.length,
        metrics: meanMetrics(queries),
        queries,
      };
    } finally {
      await store.close();
    }
    evaluation.indexBytes = statSync(dbPath).size;
    chunksByArm.set(arm, chunks);
    evaluations.push(evaluation);
    writeFileSync(join(runDir, "chunks", `${arm}.jsonl`), jsonLines(chunks));
    writeJson(join(runDir, "retrieval", `${arm}.json`), evaluation.queries);
  }

  const seed = sha256(`${corpus.id}:${JSON.stringify(corpus.hashes)}:${fixture.queries.map(query => query.id).join(",")}`);
  const review = buildReviewArtifacts(evaluations, seed);
  const chunkReview = buildChunkReviewArtifacts(chunksByArm, seed);
  writeFileSync(join(runDir, "review.md"), review.markdown);
  writeFileSync(join(runDir, "chunk-review.md"), chunkReview.markdown);
  writeJson(join(runDir, "reviews", "review-key.json"), review.key);
  writeJson(join(runDir, "reviews", "chunk-review-key.json"), chunkReview.key);
  writeJson(join(runDir, "reviews", "judgments.json"), review.judgments);
  writeJson(join(runDir, "evaluation.json"), evaluations);
  writeFileSync(join(runDir, "report.md"), buildObjectiveReport(evaluations));
  writeJson(join(runDir, "manifest.json"), {
    version: 1,
    createdAt: new Date().toISOString(),
    corpus: { id: corpus.id, collection: corpus.collection, root: corpus.root, files: corpus.files, hashes: corpus.hashes },
    queries: { path: queriesPath, sha256: sha256(readFileSync(queriesPath, "utf8")) },
    arms: ARM_STRATEGIES,
    retrieval: { type: "vsearch", expand: false, minScore: 0, limit },
  });
  return runDir;
}
