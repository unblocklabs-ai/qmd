/**
 * QMD SDK - Library mode for programmatic access to QMD search and indexing.
 *
 * Usage:
 *   import { createStore } from '@unblocklabs/qmd'
 *
 *   const store = await createStore({
 *     dbPath: './my-index.sqlite',
 *     config: {
 *       collections: {
 *         docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *       }
 *     }
 *   })
 *
 *   const results = await store.search({ query: "how does auth work?" })
 *   await store.close()
 */

import {
  createStore as createStoreInternal,
  hybridQuery,
  vectorSearchQuery,
  structuredSearch,
  extractSnippet,
  addLineNumbers,
  DEFAULT_MULTI_GET_MAX_BYTES,
  reindexCollection,
  generateEmbeddings,
  upsertProjectedDocument,
  retractProjectedDocument,
  syncProjectedCollection,
  getCollectionGeneration,
  listCollections as storeListCollections,
  syncConfigToDb,
  getStoreCollections,
  getStoreCollection,
  getStoreGlobalContext,
  getStoreContexts,
  upsertStoreCollection,
  deleteStoreCollection,
  renameStoreCollection,
  updateStoreContext,
  removeStoreContext,
  setStoreGlobalContext,
  vacuumDatabase,
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  deleteLLMCache,
  deleteInactiveDocuments,
  clearAllEmbeddings,
  type Store as InternalStore,
  type DocumentResult,
  type DocumentNotFound,
  type DocumentExcludedByIgnore,
  type DocumentLookupError,
  type PassageRef,
  type SearchResult,
  type HybridQueryResult,
  type HybridQueryOptions,
  type HybridQueryExplain,
  type ExpandedQuery,
  type StructuredSearchOptions,
  type MultiGetResult,
  type IndexStatus,
  type IndexHealthInfo,
  type SearchHooks,
  type ReindexProgress,
  type ReindexResult,
  type EmbedProgress,
  type EmbedResult,
  type ChunkStrategy,
  type ProjectedDocument,
  type ProjectedDocumentMetadata,
  type ProjectedSyncOptions,
  type VectorSearchStage,
  type VectorSearchTiming,
  type VectorSearchTrace,
  type AllowedDocumentPaths,
  type VectorSearchOptions as InternalVSearchOptions,
  type VectorSearchResult,
} from "./store.js";
import {
  LlamaCpp,
} from "./llm.js";
import { discoverCandidates, type CandidateDiscoveryOptions, type DiscoveryCandidate } from "./query.js";
export { formatDocForEmbedding, formatQueryForEmbedding } from "./llm.js";
export type { CandidateDiscoveryOptions, DiscoveryCandidate } from "./query.js";
export type { DecisionModelOptions } from "./decision-query.js";
import {
  loadConfig,
  saveConfig,
  putCollection,
  removeCollection as collectionsRemoveCollection,
  renameCollection as collectionsRenameCollection,
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  setGlobalContext as collectionsSetGlobalContext,
  type Collection,
  type CollectionConfig,
  type NamedCollection,
  type ContextMap,
  type ConfigAccess,
} from "./collections.js";

export { openReadOnlySnapshot, type ReadOnlySnapshot, type SnapshotDocument } from "./snapshot.js";
export {
  createStructuralNoiseCheck, OPENCLAW_REM_NOISE_DETECTOR,
  type StructuralNoiseDetector, type StructuralNoiseOptions, type StructuralNoiseSpan,
} from "./structural-noise.js";
export {
  chunkMarkdownSemantically, scanMarkdownAtoms, withSpeakerContext, OPENCLAW_CHUNKING_SOURCE,
  type ChunkingOptions, type SemanticChunk, type SemanticChunkOptions, type TextAtom,
} from "./semantic-chunking.js";

// Re-export types for SDK consumers
export type {
  DocumentResult,
  DocumentNotFound,
  DocumentExcludedByIgnore,
  DocumentLookupError,
  PassageRef,
  SearchResult,
  HybridQueryResult,
  HybridQueryOptions,
  HybridQueryExplain,
  ExpandedQuery,
  StructuredSearchOptions,
  MultiGetResult,
  IndexStatus,
  IndexHealthInfo,
  SearchHooks,
  ReindexProgress,
  ReindexResult,
  EmbedProgress,
  EmbedResult,
  Collection,
  CollectionConfig,
  NamedCollection,
  ContextMap,
  VectorSearchStage,
  VectorSearchTiming,
  VectorSearchTrace,
  AllowedDocumentPaths,
  VectorSearchResult,
  ProjectedDocument,
  ProjectedDocumentMetadata,
  ProjectedSyncOptions,
};

/** Options for vsearch() — expanded vector-only semantic search. */
export type VSearchOptions = InternalVSearchOptions;

// Re-export the internal Store type for advanced consumers
export type { InternalStore };

// Re-export utility functions and types used by frontends
export { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES };
export type { ChunkStrategy } from "./store.js";

// Re-export getDefaultDbPath for CLI/MCP that need the default database location
export { getDefaultDbPath } from "./store.js";

// Re-export Maintenance class for CLI housekeeping operations
export { Maintenance } from "./maintenance.js";

/**
 * Progress info emitted during update() for each file processed.
 */
export type UpdateProgress = {
  collection: string;
  file: string;
  current: number;
  total: number;
};

/**
 * Aggregated result from update() across all collections.
 */
export type UpdateResult = {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  needsEmbedding: number;
};

/**
 * Options for the unified search() method.
 */
export interface SearchOptions extends Pick<HybridQueryOptions, "decisionModel" | "signal" | "allowedPaths" | "trace" | "timeContext"> {
  /** Simple query string — literal vector + BM25 recall, then decision-model ranking */
  query?: string;
  /** Explicit typed retrieval variants; plain query also performs no automatic expansion. */
  queries?: ExpandedQuery[];
  /** Domain intent hint — steers reranking and snippet/chunk selection */
  intent?: string;
  /** Rerank with the configured decision model (default: true); false is explicit local-only retrieval */
  rerank?: boolean;
  /** Filter to a specific collection */
  collection?: string;
  /** Filter to specific collections */
  collections?: string[];
  /** Max results (default: 10) */
  limit?: number;
  /** Optional cap on candidates after deduplication */
  candidateLimit?: number;
  /** Minimum score threshold */
  minScore?: number;
  /** Include explain traces */
  explain?: boolean;
  /** Rerank fallback strategy. Exact stored vector spans take precedence. */
  chunkStrategy?: ChunkStrategy;
}

/**
 * Options for searchLex() — BM25 keyword search.
 */
export interface LexSearchOptions {
  limit?: number;
  collection?: string | string[];
}

/**
 * Options for searchVector() — vector similarity search.
 */
export interface VectorSearchOptions {
  limit?: number;
  collection?: string | string[];
  /** Optional coarse wall-clock timings for the vector retrieval stages. */
  trace?: VectorSearchTrace;
}

/**
 * Options for expandQuery() — manual query expansion.
 */
export interface ExpandQueryOptions {
  /**
   * @deprecated Ignored. Intent no longer feeds the expansion model — caller
   * intent is meta-language the model reproduced verbatim as sub-queries.
   * Pass intent via SearchOptions instead, where it shapes reranking and
   * snippet selection.
   */
  intent?: string;
}

/**
 * Options for creating a QMD store.
 *
 * Provide `dbPath` and optionally `configPath` (YAML file) or `config` (inline).
 * If neither configPath nor config is provided, the store reads from existing
 * DB state (useful for reopening a previously-configured store).
 */
export interface StoreOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Path to a YAML config file (mutually exclusive with `config`) */
  configPath?: string;
  /** Inline collection config (mutually exclusive with `configPath`) */
  config?: CollectionConfig;
  /** Keep loaded model contexts resident until the store closes. Default: false. */
  keepModelsWarm?: boolean;
  /**
   * Positive number of embedding contexts retained after each batch. Defaults to 1 when
   * `keepModelsWarm` is true; otherwise QMD keeps the batch pool until idle unload.
   */
  idleEmbeddingContexts?: number;
}

/**
 * The QMD SDK store — provides search, retrieval, collection management,
 * context management, and indexing operations.
 *
 * All methods are async. The store manages its own LlamaCpp instance
 * (lazy-loaded, auto-unloaded after inactivity) — no global singletons.
 */
export interface QMDStore {
  /** The underlying internal store (for advanced use) */
  readonly internal: InternalStore;
  /** Path to the SQLite database */
  readonly dbPath: string;

  // ── Search ──────────────────────────────────────────────────────────

  /** Vector + BM25 retrieval with independent decision-model scoring */
  search(options: SearchOptions): Promise<HybridQueryResult[]>;

  /** Exact-depth local candidate discovery, without expansion or remote scoring. */
  discoverCandidates(options: CandidateDiscoveryOptions): Promise<DiscoveryCandidate[]>;

  /** BM25 keyword search (fast, no LLM) */
  searchLex(query: string, options?: LexSearchOptions): Promise<SearchResult[]>;

  /** Vector similarity search (embedding model, no reranking) */
  searchVector(query: string, options?: VectorSearchOptions): Promise<SearchResult[]>;

  /** Expanded vector-only semantic search with exact winning chunk spans. */
  vsearch(query: string, options?: VSearchOptions): Promise<VectorSearchResult[]>;

  /** Expand a query into typed sub-searches (lex/vec/hyde) for manual control */
  expandQuery(query: string, options?: ExpandQueryOptions): Promise<ExpandedQuery[]>;

  // ── Document Retrieval ──────────────────────────────────────────────

  /** Get a single document by path or docid */
  get(pathOrDocid: string, options?: { includeBody?: boolean }): Promise<DocumentResult | DocumentLookupError>;

  /** Get the body content of a document, optionally sliced by line range */
  getDocumentBody(pathOrDocid: string, opts?: { fromLine?: number; maxLines?: number }): Promise<string | null>;

  /** Get multiple documents by glob pattern or comma-separated list */
  multiGet(pattern: string, options?: { includeBody?: boolean; maxBytes?: number }): Promise<{ docs: MultiGetResult[]; errors: string[] }>;

  // ── Collection Management ───────────────────────────────────────────

  /** Add or update a collection */
  addCollection(name: string, opts: CollectionConfig["collections"][string]): Promise<void>;

  /** Remove a collection */
  removeCollection(name: string): Promise<boolean>;

  /** Rename a collection */
  renameCollection(oldName: string, newName: string): Promise<boolean>;

  /** List all collections with document stats */
  listCollections(): Promise<ReturnType<typeof storeListCollections>>;

  /** Get names of collections included by default in queries */
  getDefaultCollectionNames(): Promise<string[]>;

  // ── Context Management ──────────────────────────────────────────────

  /** Add context for a path within a collection */
  addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;

  /** Remove context from a collection path */
  removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;

  /** Set global context (applies to all collections) */
  setGlobalContext(context: string | undefined): Promise<void>;

  /** Get global context */
  getGlobalContext(): Promise<string | undefined>;

  /** List all contexts across all collections */
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;

  // ── Indexing ────────────────────────────────────────────────────────

  /** Re-index collections by scanning the filesystem */
  update(options?: {
    collections?: string[];
    onProgress?: (info: UpdateProgress) => void;
  }): Promise<UpdateResult>;

  /** Insert, update, or reactivate a document in a projected collection. */
  upsertDocument(collection: string, path: string, content: string, opts?: ProjectedDocumentMetadata): Promise<{ changed: boolean; hash: string; docid: string; generation: number }>;

  /** Deactivate a projected document. Repeating a retraction is a no-op. */
  retractDocument(collection: string, path: string): Promise<{ deactivated: boolean; generation: number }>;

  /** Reconcile the complete desired set of paths, atomically with its generation. */
  syncProjectedCollection(collection: string, docs: Iterable<ProjectedDocument>, opts?: ProjectedSyncOptions): Promise<{ upserted: number; unchanged: number; retracted: number; embedded: number; generation: number }>;

  /** Read the latest committed collection generation (zero before the first change). */
  getCollectionGeneration(collection: string): Promise<number>;

  /** Generate vector embeddings for documents that need them */
  embed(options?: {
    force?: boolean;
    model?: string;
    /** Restrict embedding to documents in one collection. */
    collection?: string;
    maxDocsPerBatch?: number;
    maxBatchBytes?: number;
    /** Persisted index-wide strategy. Changing it requires an unscoped embed. */
    chunkStrategy?: ChunkStrategy;
    onProgress?: (info: EmbedProgress) => void;
  }): Promise<EmbedResult>;

  // ── Index Health ────────────────────────────────────────────────────

  /** Get index status (document counts, collections, embedding state) */
  getStatus(): Promise<IndexStatus>;

  /** Get index health info (stale embeddings, etc.) */
  getIndexHealth(): Promise<IndexHealthInfo>;

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Close the store and release all resources (LLM models, DB connection) */
  close(): Promise<void>;
}

/**
 * Create a QMD store for programmatic access to search and indexing.
 *
 * @example
 * ```typescript
 * // With a YAML config file
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   configPath: './qmd.yml',
 * })
 *
 * // With inline config (no files needed besides the DB)
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   config: {
 *     collections: {
 *       docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *     }
 *   }
 * })
 *
 * const results = await store.search({ query: "authentication flow" })
 * await store.close()
 * ```
 */
export async function createStore(options: StoreOptions): Promise<QMDStore> {
  if (!options.dbPath) {
    throw new Error("dbPath is required");
  }
  if (options.configPath && options.config) {
    throw new Error("Provide either configPath or config, not both");
  }

  const { configPath, config: inlineConfig } = options;
  const configAccess: ConfigAccess | undefined = configPath
    ? { load: () => loadConfig(configPath), save: config => saveConfig(config, configPath) }
    : inlineConfig
      ? { load: () => inlineConfig, save: () => {} }
      : undefined;
  const config = configAccess?.load();
  const internal = createStoreInternal(options.dbPath);
  const db = internal.db;
  try {
    if (config) {
      config.collections ??= {};
      syncConfigToDb(db, config);
    }
  } catch (error) {
    internal.close();
    throw error;
  }

  // Create a per-store LlamaCpp instance — lazy-loads models on first use and,
  // unless explicitly kept warm, unloads them after 5 min inactivity.
  const llm = new LlamaCpp({
    embedModel: config?.models?.embed,
    generateModel: config?.models?.generate,
    rerankModel: config?.models?.rerank,
    inactivityTimeoutMs: options.keepModelsWarm ? 0 : 5 * 60 * 1000,
    disposeModelsOnInactivity: true,
    idleEmbeddingContexts: options.idleEmbeddingContexts ?? (options.keepModelsWarm ? 1 : undefined),
  });
  internal.llm = llm;

  const store: QMDStore = {
    internal,
    dbPath: internal.dbPath,
    discoverCandidates: (opts) => discoverCandidates(internal, opts),

    // Search
    search: async (opts) => {
      if (!opts.query && !opts.queries) {
        throw new Error("search() requires either 'query' or 'queries'");
      }
      // Normalize collection/collections
      const collections = [
        ...(opts.collection ? [opts.collection] : []),
        ...(opts.collections ?? []),
      ];
      const skipRerank = opts.rerank === false;

      if (opts.queries) {
        // Pre-expanded queries — use structuredSearch
        return structuredSearch(internal, opts.queries, {
          collections: collections.length > 0 ? collections : undefined,
          limit: opts.limit,
          minScore: opts.minScore,
          explain: opts.explain,
          intent: opts.intent,
          candidateLimit: opts.candidateLimit,
          skipRerank,
          chunkStrategy: opts.chunkStrategy,
          decisionModel: opts.decisionModel, signal: opts.signal, allowedPaths: opts.allowedPaths,
          trace: opts.trace, timeContext: opts.timeContext,
        });
      }

      // Literal vector + BM25 retrieval, then independent decision-model scoring.
      return hybridQuery(internal, opts.query!, {
        collection: collections.length > 0 ? collections : undefined,
        limit: opts.limit,
        minScore: opts.minScore,
        explain: opts.explain,
        intent: opts.intent,
        candidateLimit: opts.candidateLimit,
        skipRerank,
        chunkStrategy: opts.chunkStrategy,
        decisionModel: opts.decisionModel, signal: opts.signal, allowedPaths: opts.allowedPaths,
        trace: opts.trace, timeContext: opts.timeContext,
      });
    },
    searchLex: async (q, opts) => internal.searchFTS(q, opts?.limit, opts?.collection),
    searchVector: async (q, opts) => internal.searchVec(q, llm.embedModelName, opts?.limit, opts?.collection, undefined, undefined, opts?.trace),
    vsearch: async (q, opts) => vectorSearchQuery(internal, q, opts),
    expandQuery: async (q) => internal.expandQuery(q),
    get: async (pathOrDocid, opts) => internal.findDocument(pathOrDocid, opts),
    getDocumentBody: async (pathOrDocid, opts) => {
      const result = internal.findDocument(pathOrDocid, { includeBody: false });
      if ("error" in result) return null;
      return internal.getDocumentBody(result, opts?.fromLine, opts?.maxLines);
    },
    multiGet: async (pattern, opts) => internal.findDocuments(pattern, opts),

    // Collection Management — write to SQLite + write-through to YAML/inline if configured
    addCollection: async (name, opts) => {
      const collection = { ...opts, pattern: opts.pattern ?? "**/*.md" };
      upsertStoreCollection(db, name, collection);
      if (configAccess) putCollection(name, collection, configAccess);
    },
    removeCollection: async (name) => {
      const result = deleteStoreCollection(db, name);
      if (configAccess) collectionsRemoveCollection(name, configAccess);
      return result;
    },
    renameCollection: async (oldName, newName) => {
      const result = renameStoreCollection(db, oldName, newName);
      if (configAccess) collectionsRenameCollection(oldName, newName, configAccess);
      return result;
    },
    listCollections: async () => storeListCollections(db),
    getDefaultCollectionNames: async () => {
      const collections = storeListCollections(db);
      return collections.filter(c => c.includeByDefault).map(c => c.name);
    },

    // Context Management — write to SQLite + write-through to YAML/inline if configured
    addContext: async (collectionName, pathPrefix, contextText) => {
      const result = updateStoreContext(db, collectionName, pathPrefix, contextText);
      if (configAccess) collectionsAddContext(collectionName, pathPrefix, contextText, configAccess);
      return result;
    },
    removeContext: async (collectionName, pathPrefix) => {
      const result = removeStoreContext(db, collectionName, pathPrefix);
      if (configAccess) collectionsRemoveContext(collectionName, pathPrefix, configAccess);
      return result;
    },
    setGlobalContext: async (context) => {
      setStoreGlobalContext(db, context);
      if (configAccess) collectionsSetGlobalContext(context, configAccess);
    },
    getGlobalContext: async () => getStoreGlobalContext(db),
    listContexts: async () => getStoreContexts(db),

    // Indexing — reads collections from SQLite
    update: async (updateOpts) => {
      const collections = getStoreCollections(db).filter(c => !c.projected);
      const filtered = updateOpts?.collections
        ? collections.filter(c => updateOpts.collections!.includes(c.name))
        : collections;

      internal.clearCache();

      let totalIndexed = 0, totalUpdated = 0, totalUnchanged = 0, totalRemoved = 0, totalSkipped = 0;

      for (const col of filtered) {
        const result = await reindexCollection(internal, col.path, col.pattern || "**/*.md", col.name, {
          ignorePatterns: col.ignore,
          onProgress: updateOpts?.onProgress
            ? (info) => updateOpts.onProgress!({ collection: col.name, ...info })
            : undefined,
        });
        totalIndexed += result.indexed;
        totalUpdated += result.updated;
        totalUnchanged += result.unchanged;
        totalRemoved += result.removed;
        totalSkipped += result.skipped;
      }

      return {
        collections: filtered.length,
        indexed: totalIndexed,
        updated: totalUpdated,
        unchanged: totalUnchanged,
        removed: totalRemoved,
        skipped: totalSkipped,
        needsEmbedding: internal.getHashesNeedingEmbedding(),
      };
    },

    upsertDocument: async (collection, path, content, opts) => upsertProjectedDocument(db, collection, { ...opts, path, content }),
    retractDocument: async (collection, path) => retractProjectedDocument(db, collection, path),
    syncProjectedCollection: (collection, docs, opts) => syncProjectedCollection(internal, collection, docs, opts),
    getCollectionGeneration: async collection => getCollectionGeneration(db, collection),

    embed: async (embedOpts) => {
      return generateEmbeddings(internal, {
        force: embedOpts?.force,
        model: embedOpts?.model,
        collection: embedOpts?.collection,
        maxDocsPerBatch: embedOpts?.maxDocsPerBatch,
        maxBatchBytes: embedOpts?.maxBatchBytes,
        chunkStrategy: embedOpts?.chunkStrategy,
        onProgress: embedOpts?.onProgress,
      });
    },

    // Index Health
    getStatus: async () => internal.getStatus(),
    getIndexHealth: async () => internal.getIndexHealth(),

    // Lifecycle
    close: async () => {
      await llm.dispose();
      internal.close();
    },
  };

  return store;
}
