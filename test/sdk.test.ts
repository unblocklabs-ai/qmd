/**
 * sdk.test.ts - Unit tests for the QMD SDK (library mode)
 *
 * Tests the public API exposed via `@unblocklabs/qmd` (src/index.ts).
 * Uses inline config (no YAML files) to verify the SDK works self-contained.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import YAML from "yaml";
import {
  createStore,
  openReadOnlySnapshot,
  type QMDStore,
  type CollectionConfig,
  type StoreOptions,
  type UpdateProgress,
  type SearchOptions,
  type LexSearchOptions,
  type VectorSearchOptions,
  type ExpandQueryOptions,
} from "../src/index.js";
import { setDefaultLlamaCpp } from "../src/llm.js";
import { getConfigPath, setConfigSource } from "../src/collections.js";
import { reindexCollection, resolveVirtualPath } from "../src/store.js";

// =============================================================================
// Test Helpers
// =============================================================================

let testDir: string;
let docsDir: string;
let notesDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-sdk-test-"));
  docsDir = join(testDir, "docs");
  notesDir = join(testDir, "notes");

  // Create test directories with sample markdown files
  await mkdir(docsDir, { recursive: true });
  await mkdir(notesDir, { recursive: true });

  await writeFile(join(docsDir, "readme.md"), "# Getting Started\n\nThis is the getting started guide for the project.\n");
  await writeFile(join(docsDir, "auth.md"), "# Authentication\n\nAuthentication uses JWT tokens for session management.\nUsers log in with email and password.\n");
  await writeFile(join(docsDir, "api.md"), "# API Reference\n\n## Endpoints\n\n### POST /login\nAuthenticate a user.\n\n### GET /users\nList all users.\n");
  await writeFile(join(notesDir, "meeting-2025-01.md"), "# January Planning Meeting\n\nDiscussed Q1 roadmap and resource allocation.\n");
  await writeFile(join(notesDir, "meeting-2025-02.md"), "# February Standup\n\nReviewed sprint progress. Authentication feature is on track.\n");
  await writeFile(join(notesDir, "ideas.md"), "# Project Ideas\n\n- Build a search engine\n- Create a knowledge base\n- Implement vector search\n");
});

afterAll(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

function freshDbPath(): string {
  return join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

describe("projected corpus", () => {
  test("filesystem updates ignore projected collections, including after reopening without config", async () => {
    const dbPath = freshDbPath();
    const writer = await createStore({ dbPath, config: { collections: {
      docs: { path: docsDir },
      sessions: { projected: true, path: docsDir },
    } } });
    try {
      await writer.upsertDocument("sessions", "virtual/first.md", "Projectedonly transcript");
    } finally {
      await writer.close();
    }
    const store = await createStore({ dbPath });
    try {
      expect(await store.update()).toMatchObject({ indexed: 3, removed: 0 });
      expect(await reindexCollection(store.internal, docsDir, "**/*.md", "sessions"))
        .toMatchObject({ indexed: 0, removed: 0 });
      expect((await store.searchLex("projectedonly")).map(hit => hit.filepath)).toEqual(["qmd://sessions/virtual/first.md"]);
      expect(await store.listCollections()).toContainEqual(expect.objectContaining({ name: "sessions", active_count: 1, projected: true }));
      expect(resolveVirtualPath(store.internal.db, "qmd://sessions/auth.md")).toBeNull();
      expect(await store.getCollectionGeneration("sessions")).toBe(1);
    } finally {
      await store.close();
    }
  });

  test("acks changes to exact body and metadata, keeps no-ops at the current generation, and reactivates", async () => {
    const store = await createStore({ dbPath: freshDbPath() });
    try {
      await store.addCollection("projected", { projected: true });
      const path = "space & case/Note.md";
      const content = "# Raw\r\n\r\nplainbodytoken\r\n";
      const metadata = { title: "Source title", createdAt: "2020-01-01T00:00:00Z", modifiedAt: "2020-02-01T00:00:00Z" };
      const first = await store.upsertDocument("projected", path, content, metadata);
      expect(first).toMatchObject({ changed: true, generation: 1 });
      expect(first.docid).toBe(first.hash.slice(0, 6));
      expect(await store.upsertDocument("projected", path, content, metadata)).toEqual({ ...first, changed: false });
      expect(await store.getDocumentBody(`qmd://projected/${path}`)).toBe(content);
      expect(await store.get(`#${first.docid}`)).toMatchObject({ title: "Source title" });

      const renamed = await store.upsertDocument("projected", path, content, { ...metadata, title: "Changed title" });
      expect(renamed).toEqual({ ...first, generation: 2 });
      expect(await store.get(`#${first.docid}`)).toMatchObject({ title: "Changed title" });
      expect(await store.retractDocument("projected", path)).toEqual({ deactivated: true, generation: 3 });
      expect(await store.searchLex("plainbodytoken")).toEqual([]);
      expect(await store.retractDocument("projected", path)).toEqual({ deactivated: false, generation: 3 });
      expect(await store.upsertDocument("projected", path, content, metadata)).toEqual({ ...first, generation: 4 });
      expect(await store.getCollectionGeneration("projected")).toBe(4);
      await expect(store.upsertDocument("projected", "../unsafe", content)).rejects.toThrow("collection-relative");
      await expect(store.upsertDocument("unknown", path, content)).rejects.toThrow("not a configured projected collection");
    } finally {
      await store.close();
    }
  });

  test("sync commits neither staged rows nor retractions for an incomplete source", async () => {
    const store = await createStore({ dbPath: freshDbPath(), config: { collections: { projected: { projected: true } } } });
    try {
      await store.upsertDocument("projected", "retained.md", "original");
      const controller = new AbortController();
      function* interrupted() {
        yield { path: "staged.md", content: "don't commit" };
        controller.abort(new Error("source closed"));
      }
      await expect(store.syncProjectedCollection("projected", interrupted(), { signal: controller.signal, embed: true }))
        .rejects.toThrow("source closed");
      await expect(store.syncProjectedCollection("projected", [
        { path: "same.md", content: "first" }, { path: "same.md", content: "second" },
      ])).rejects.toThrow("Duplicate projected document path");
      expect(await store.getDocumentBody("qmd://projected/retained.md")).toBe("original");
      expect(await store.getDocumentBody("qmd://projected/staged.md")).toBeNull();
      expect(await store.getCollectionGeneration("projected")).toBe(1);
    } finally {
      await store.close();
    }
  });

  test("pins active documents, bodies and generations to the same live SQLite read", async () => {
    const dbPath = freshDbPath();
    const store = await createStore({ dbPath, config: { collections: { projected: { projected: true } } } });
    try {
      const modifiedAt = "2026-01-02T03:04:05Z";
      const first = await store.upsertDocument("projected", "one.md", "first", { title: "One", modifiedAt });
      await store.upsertDocument("projected", "inactive.md", "inactive");
      await store.retractDocument("projected", "inactive.md");
      const read = openReadOnlySnapshot(dbPath);
      try {
        await store.upsertDocument("projected", "one.md", "second");
        expect(read.listActiveDocuments(["missing", "projected", "projected"])).toEqual([
          { id: expect.any(Number), collection: "projected", path: "one.md", hash: first.hash, title: "One", modifiedAt },
        ]);
        expect(read.listActiveDocuments([])).toEqual([]);
        expect(read.getDocumentBody("projected", "inactive.md")).toBeNull();
        expect(read.getDocumentBody("projected", "one.md")).toBe("first");
        expect(read.getCollectionGeneration("projected")).toBe(3);
        expect(read.getCollectionGeneration("missing")).toBe(0);
        const latest = openReadOnlySnapshot(dbPath);
        try {
          expect(latest.getCollectionGeneration("projected")).toBe(4);
          expect(latest.getDocumentBody("projected", "one.md")).toBe("second");
        } finally {
          latest.close();
        }
      } finally {
        read.close();
      }
    } finally {
      await store.close();
    }
  });

  test("opens an idle or legacy index without writing files, bootstrapping schema, or changing config", async () => {
    const dir = await mkdtemp(join(testDir, "snapshot-"));
    const dbPath = join(dir, "index #1.sqlite");
    const store = await createStore({ dbPath, config: { collections: { projected: { projected: true } } } });
    try {
      await store.upsertDocument("projected", "one.md", "original");
      store.internal.db.exec("DROP TABLE collection_generations");
      // Bun can leave empty WAL sidecars after close. Entering WAL mode without
      // subsequent writes gives both drivers a checkpointed, sidecar-free file.
      store.internal.db.exec("PRAGMA journal_mode = DELETE; PRAGMA journal_mode = WAL");
    } finally {
      await store.close();
    }
    const before = readFileSync(dbPath);
    expect(readdirSync(dir)).toEqual(["index #1.sqlite"]);
    setConfigSource({ configPath: join(dir, "unrelated.yml") });
    try {
      const read = openReadOnlySnapshot(dbPath);
      try {
        expect(read.listActiveDocuments()).toHaveLength(1);
        expect(read.getDocumentBody("projected", "one.md")).toBe("original");
        expect(read.getCollectionGeneration("projected")).toBe(0);
        expect(readdirSync(dir)).toEqual(["index #1.sqlite"]);
      } finally {
        read.close();
      }
      expect(getConfigPath()).toBe(join(dir, "unrelated.yml"));
      expect(readFileSync(dbPath)).toEqual(before);
      expect(() => openReadOnlySnapshot(join(dir, "missing.sqlite"))).toThrow(/ENOENT/);
      expect(readdirSync(dir)).toEqual(["index #1.sqlite"]);
    } finally {
      setConfigSource();
    }
  });

  test("concurrent inline stores isolate config changes and closing either leaves the global source alone", async () => {
    const a: CollectionConfig = { collections: { a: { projected: true } } };
    const b: CollectionConfig = { collections: { b: { projected: true } } };
    const sentinel = join(testDir, "unrelated-global.yml");
    setConfigSource({ configPath: sentinel });
    const [left, right] = await Promise.all([
      createStore({ dbPath: freshDbPath(), config: a }),
      createStore({ dbPath: freshDbPath(), config: b }),
    ]);
    try {
      await Promise.all([left.addContext("a", "/", "left only"), right.setGlobalContext("right only")]);
      expect(a.collections.a?.context).toEqual({ "/": "left only" });
      expect(a.global_context).toBeUndefined();
      expect(b.collections.b?.context).toBeUndefined();
      expect(b.global_context).toBe("right only");
      expect(getConfigPath()).toBe(sentinel);
      await left.close();
      await right.addCollection("right-new", { projected: true });
      expect(Object.keys(a.collections)).toEqual(["a"]);
      expect(Object.keys(b.collections)).toEqual(["b", "right-new"]);
      expect((await right.listCollections()).map(row => row.name)).toEqual(["b", "right-new"]);
    } finally {
      await right.close();
      setConfigSource();
    }
    expect(existsSync(sentinel)).toBe(false);
  });
});

test("update deactivates a blanked file and restores it when content returns", async () => {
  const root = await mkdtemp(join(testDir, "blanked-"));
  const file = join(root, "note.md");
  const body = "# Note\n\nquartzblankingproof\n";
  await writeFile(file, body);
  const store = await createStore({ dbPath: freshDbPath(), config: { collections: { notes: { path: root } } } });
  try {
    expect((await store.update()).indexed).toBe(1);
    expect(await store.searchLex("quartzblankingproof")).toHaveLength(1);
    for (const empty of ["", " \n\t "]) {
      await writeFile(file, empty);
      expect((await store.update()).removed).toBe(1);
      expect(await store.searchLex("quartzblankingproof")).toHaveLength(0);
      expect((await store.update()).removed).toBe(0);
      await writeFile(file, body);
      await store.update();
      expect(await store.searchLex("quartzblankingproof")).toHaveLength(1);
    }
  } finally {
    await store.close();
  }
});

// =============================================================================
// Constructor Tests
// =============================================================================

describe("createStore", () => {
  test("creates store with inline config", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    expect(store).toBeDefined();
    expect(store.dbPath).toBeTruthy();
    expect(store.internal).toBeDefined();
    expect((store.internal.llm as { inactivityTimeoutMs: number }).inactivityTimeoutMs).toBe(5 * 60 * 1000);
    await store.close();
  });

  test("can keep models warm for the store lifetime", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
      keepModelsWarm: true,
    });

    const llm = store.internal.llm as {
      inactivityTimeoutMs: number;
      idleEmbeddingContexts: number;
    };
    expect(llm.inactivityTimeoutMs).toBe(0);
    expect(llm.idleEmbeddingContexts).toBe(1);
    await store.close();
  });

  test("allows the warm embedding context count to be configured", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
      keepModelsWarm: true,
      idleEmbeddingContexts: 2,
    });

    const llm = store.internal.llm as { idleEmbeddingContexts: number };
    expect(llm.idleEmbeddingContexts).toBe(2);
    await store.close();
  });

  test("creates store with YAML config file", async () => {
    const configPath = join(testDir, "test-config.yml");
    const config: CollectionConfig = {
      collections: {
        docs: { path: docsDir, pattern: "**/*.md" },
      },
    };
    writeFileSync(configPath, YAML.stringify(config));

    const store = await createStore({
      dbPath: freshDbPath(),
      configPath,
    });

    expect(store).toBeDefined();
    await store.close();
  });

  test("throws if dbPath is missing", async () => {
    await expect(
      createStore({ dbPath: "", config: { collections: {} } })
    ).rejects.toThrow("dbPath is required");
  });

  test("opens with just dbPath (DB-only mode)", async () => {
    const store = await createStore({ dbPath: freshDbPath() } as StoreOptions);
    expect(store).toBeDefined();
    // No collections yet — fresh DB
    const collections = await store.listCollections();
    expect(collections).toEqual([]);
    await store.close();
  });

  test("throws if both configPath and config are provided", async () => {
    await expect(
      createStore({
        dbPath: freshDbPath(),
        configPath: "/some/path.yml",
        config: { collections: {} },
      })
    ).rejects.toThrow("Provide either configPath or config, not both");
  });

  test("creates database file on disk", async () => {
    const dbPath = freshDbPath();
    const store = await createStore({
      dbPath,
      config: { collections: {} },
    });

    expect(existsSync(dbPath)).toBe(true);
    await store.close();
  });

  test("store.dbPath matches the provided path", async () => {
    const dbPath = freshDbPath();
    const store = await createStore({
      dbPath,
      config: { collections: {} },
    });

    expect(store.dbPath).toBe(dbPath);
    await store.close();
  });
});

// =============================================================================
// Collection Management Tests
// =============================================================================

describe("collection management", () => {
  let store: QMDStore;

  beforeEach(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });
  });

  afterEach(async () => {
    await store.close();
  });

  test("addCollection adds a collection to inline config", async () => {
    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });

    const collections = await store.listCollections();
    const names = collections.map(c => c.name);
    expect(names).toContain("docs");
  });

  test("addCollection with default pattern", async () => {
    await store.addCollection("notes", { path: notesDir });

    const collections = await store.listCollections();
    expect(collections.find(c => c.name === "notes")).toBeDefined();
  });

  test("removeCollection removes existing collection", async () => {
    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });
    const removed = await store.removeCollection("docs");

    expect(removed).toBe(true);
    const collections = await store.listCollections();
    expect(collections.map(c => c.name)).not.toContain("docs");
  });

  test("removeCollection returns false for non-existent collection", async () => {
    const removed = await store.removeCollection("nonexistent");
    expect(removed).toBe(false);
  });

  test("renameCollection renames a collection", async () => {
    await store.addCollection("old-name", { path: docsDir, pattern: "**/*.md" });
    const renamed = await store.renameCollection("old-name", "new-name");

    expect(renamed).toBe(true);
    const names = (await store.listCollections()).map(c => c.name);
    expect(names).toContain("new-name");
    expect(names).not.toContain("old-name");
  });

  test("renameCollection returns false for non-existent source", async () => {
    const renamed = await store.renameCollection("nonexistent", "new-name");
    expect(renamed).toBe(false);
  });

  test("renameCollection throws if target exists", async () => {
    await store.addCollection("a", { path: docsDir, pattern: "**/*.md" });
    await store.addCollection("b", { path: notesDir, pattern: "**/*.md" });

    await expect(store.renameCollection("a", "b")).rejects.toThrow("already exists");
  });

  test("listCollections returns empty array for empty config", async () => {
    const collections = await store.listCollections();
    expect(collections).toEqual([]);
  });

  test("multiple collections can be added", async () => {
    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });
    await store.addCollection("notes", { path: notesDir, pattern: "**/*.md" });

    const names = (await store.listCollections()).map(c => c.name);
    expect(names).toContain("docs");
    expect(names).toContain("notes");
    expect(names).toHaveLength(2);
  });
});

// =============================================================================
// Context Management Tests
// =============================================================================

describe("context management", () => {
  let store: QMDStore;

  beforeEach(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });
  });

  afterEach(async () => {
    await store.close();
  });

  test("addContext adds context to a collection path", async () => {
    const added = await store.addContext("docs", "/auth", "Authentication docs");
    expect(added).toBe(true);

    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/auth",
      context: "Authentication docs",
    });
  });

  test("addContext returns false for non-existent collection", async () => {
    const added = await store.addContext("nonexistent", "/path", "Some context");
    expect(added).toBe(false);
  });

  test("removeContext removes existing context", async () => {
    await store.addContext("docs", "/auth", "Authentication docs");
    const removed = await store.removeContext("docs", "/auth");

    expect(removed).toBe(true);
    const contexts = await store.listContexts();
    expect(contexts.find(c => c.path === "/auth")).toBeUndefined();
  });

  test("removeContext returns false for non-existent context", async () => {
    const removed = await store.removeContext("docs", "/nonexistent");
    expect(removed).toBe(false);
  });

  test("setGlobalContext sets and retrieves global context", async () => {
    await store.setGlobalContext("Global knowledge base");
    const global = await store.getGlobalContext();

    expect(global).toBe("Global knowledge base");
  });

  test("setGlobalContext with undefined clears it", async () => {
    await store.setGlobalContext("Some context");
    await store.setGlobalContext(undefined);
    const global = await store.getGlobalContext();

    expect(global).toBeUndefined();
  });

  test("listContexts includes global context", async () => {
    await store.setGlobalContext("Global context");
    const contexts = await store.listContexts();

    expect(contexts).toContainEqual({
      collection: "*",
      path: "/",
      context: "Global context",
    });
  });

  test("listContexts returns contexts across multiple collections", async () => {
    await store.addContext("docs", "/", "Documentation");
    await store.addContext("notes", "/", "Personal notes");

    const contexts = await store.listContexts();
    expect(contexts.filter(c => c.path === "/")).toHaveLength(2);
  });

  test("multiple contexts on same collection", async () => {
    await store.addContext("docs", "/auth", "Auth docs");
    await store.addContext("docs", "/api", "API docs");

    const contexts = (await store.listContexts()).filter(c => c.collection === "docs");
    expect(contexts).toHaveLength(2);
    expect(contexts.map(c => c.path).sort()).toEqual(["/api", "/auth"]);
  });

  test("addContext overwrites existing context for same path", async () => {
    await store.addContext("docs", "/auth", "Old context");
    await store.addContext("docs", "/auth", "New context");

    const contexts = (await store.listContexts()).filter(c => c.path === "/auth");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.context).toBe("New context");
  });
});

// =============================================================================
// Inline Config Isolation Tests
// =============================================================================

describe("inline config isolation", () => {
  test("inline config does not write any files to disk", async () => {
    const configDir = join(testDir, "should-not-exist");
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.addCollection("notes", { path: notesDir, pattern: "**/*.md" });
    await store.addContext("docs", "/", "Documentation");

    expect(existsSync(configDir)).toBe(false);
    await store.close();
  });

  test("inline config mutations persist within session", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });
    await store.addContext("docs", "/", "My docs");

    // Verify the mutations are visible
    const collections = await store.listCollections();
    expect(collections.map(c => c.name)).toContain("docs");

    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/",
      context: "My docs",
    });

    await store.close();
  });

  test("two stores with different inline configs are independent", async () => {
    const store1 = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    // Close first store (resets config source)
    await store1.close();

    const store2 = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const names = (await store2.listCollections()).map(c => c.name);
    expect(names).toContain("notes");
    expect(names).not.toContain("docs");

    await store2.close();
  });
});

// =============================================================================
// YAML Config File Tests
// =============================================================================

describe("YAML config file mode", () => {
  test("loads collections from YAML file", async () => {
    const configPath = join(testDir, `config-${Date.now()}.yml`);
    const config: CollectionConfig = {
      collections: {
        docs: { path: docsDir, pattern: "**/*.md" },
        notes: { path: notesDir, pattern: "**/*.md" },
      },
    };
    writeFileSync(configPath, YAML.stringify(config));

    const store = await createStore({ dbPath: freshDbPath(), configPath });
    const names = (await store.listCollections()).map(c => c.name);

    expect(names).toContain("docs");
    expect(names).toContain("notes");
    await store.close();
  });

  test("addCollection persists to YAML file", async () => {
    const configPath = join(testDir, `config-persist-${Date.now()}.yml`);
    writeFileSync(configPath, YAML.stringify({ collections: {} }));

    const store = await createStore({ dbPath: freshDbPath(), configPath });
    await store.addCollection("newcol", { path: docsDir, pattern: "**/*.md" });
    await store.close();

    // Read the YAML file directly and verify
    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as CollectionConfig;
    expect(parsed.collections).toHaveProperty("newcol");
    expect(parsed.collections.newcol!.path).toBe(docsDir);
  });

  test("context persists to YAML file", async () => {
    const configPath = join(testDir, `config-ctx-${Date.now()}.yml`);
    writeFileSync(configPath, YAML.stringify({
      collections: { docs: { path: docsDir, pattern: "**/*.md" } },
    }));

    const store = await createStore({ dbPath: freshDbPath(), configPath });
    await store.addContext("docs", "/api", "API documentation");
    await store.close();

    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as CollectionConfig;
    expect(parsed.collections.docs!.context).toEqual({ "/api": "API documentation" });
  });

  test("non-existent config file returns empty collections", async () => {
    const configPath = join(testDir, "nonexistent-config.yml");
    const store = await createStore({ dbPath: freshDbPath(), configPath });
    const collections = await store.listCollections();

    expect(collections).toEqual([]);
    await store.close();
  });
});

// =============================================================================
// Search Tests (BM25 - no LLM needed)
// =============================================================================

describe("searchLex (BM25)", () => {
  let store: QMDStore;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = join(testDir, "search-test.sqlite");
    store = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    // Index documents manually using internal store
    const now = new Date().toISOString();
    const { internal } = store;
    const fs = require("fs");

    // Index docs collection
    for (const file of ["readme.md", "auth.md", "api.md"]) {
      const fullPath = join(docsDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const hash = require("crypto").createHash("sha256").update(content).digest("hex");
      const title = content.match(/^#\s+(.+)/m)?.[1] || file;

      internal.insertContent(hash, content, now);
      internal.insertDocument("docs", `qmd://docs/${file}`, title, hash, now, now);
    }

    // Index notes collection
    for (const file of ["meeting-2025-01.md", "meeting-2025-02.md", "ideas.md"]) {
      const fullPath = join(notesDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const hash = require("crypto").createHash("sha256").update(content).digest("hex");
      const title = content.match(/^#\s+(.+)/m)?.[1] || file;

      internal.insertContent(hash, content, now);
      internal.insertDocument("notes", `qmd://notes/${file}`, title, hash, now, now);
    }
  });

  afterAll(async () => {
    await store.close();
  });

  test("searchLex returns results for matching query", async () => {
    const results = await store.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);
  });

  test("searchLex results have expected shape", async () => {
    const results = await store.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);

    const result = results[0]!;
    expect(result).toHaveProperty("filepath");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("docid");
    expect(result).toHaveProperty("collectionName");
    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThan(0);
  });

  test("searchLex respects limit option", async () => {
    const results = await store.searchLex("meeting", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("searchLex with collection filter", async () => {
    const results = await store.searchLex("authentication", { collection: "notes" });
    for (const r of results) {
      expect(r.collectionName).toBe("notes");
    }
  });

  test("searchLex returns empty for non-matching query", async () => {
    const results = await store.searchLex("xyznonexistentterm123");
    expect(results).toHaveLength(0);
  });

  test("searchLex finds documents across collections", async () => {
    const results = await store.searchLex("authentication", { limit: 10 });
    const collections = new Set(results.map(r => r.collectionName));
    // Auth appears in both docs/auth.md and notes/meeting-2025-02.md
    expect(collections.size).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Unified search() API Tests
// =============================================================================

describe("search (unified API)", () => {
  let store: QMDStore;

  beforeAll(async () => {
    store = await createStore({
      dbPath: join(testDir, "unified-search-test.sqlite"),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
  });

  test("search() requires query or queries", async () => {
    await expect(store.search({} as SearchOptions)).rejects.toThrow("requires either 'query' or 'queries'");
  });

  test("search() with pre-expanded queries and rerank:false", async () => {
    const results = await store.search({
      queries: [
        { type: "lex", query: "authentication JWT" },
        { type: "lex", query: "login session" },
      ],
      rerank: false,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  test("search() forwards candidateLimit to structured search", async () => {
    const results = await store.search({
      queries: [
        { type: "lex", query: "authentication" },
        { type: "lex", query: "meeting" },
      ],
      limit: 5,
      candidateLimit: 1,
      rerank: false,
    });

    expect(results).toHaveLength(1);
  });

  describe("local-only literal hybrid retrieval", () => {
    test("search() with query and rerank:false returns results", async () => {
      const results = await store.search({ query: "authentication", rerank: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty("file");
      expect(results[0]).toHaveProperty("score");
      expect(results[0]).toHaveProperty("title");
      expect(results[0]).toHaveProperty("bestChunk");
      expect(results[0]).toHaveProperty("docid");
    }, 90000);

    test("search() with intent and rerank:false returns results", async () => {
      const results = await store.search({
        query: "meeting",
        intent: "quarterly planning and roadmap",
        rerank: false,
      });
      expect(results.length).toBeGreaterThan(0);
    }, 60000);

    test("search() with collection filter", async () => {
      const results = await store.search({
        query: "authentication",
        collection: "docs",
        rerank: false,
      });
      for (const r of results) {
        expect(r.file).toMatch(/^qmd:\/\/docs\//);
      }
    });

    test("search() with collections filter", async () => {
      const results = await store.search({
        query: "authentication",
        collections: ["docs"],
        rerank: false,
      });
      for (const r of results) {
        expect(r.file).toMatch(/^qmd:\/\/docs\//);
      }
    });

    test("search() with limit", async () => {
      const results = await store.search({ query: "meeting", limit: 1, rerank: false });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    test("search() returns empty for non-matching query", async () => {
      const results = await store.search({ query: "xyznonexistentterm123", rerank: false });
      expect(results).toHaveLength(0);
    });
  });
});

// =============================================================================
// Document Retrieval Tests
// =============================================================================

describe("get and multiGet", () => {
  let store: QMDStore;

  beforeAll(async () => {
    store = await createStore({
      dbPath: join(testDir, "get-test.sqlite"),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    // Index documents
    const now = new Date().toISOString();
    const { internal } = store;
    const fs = require("fs");

    for (const file of ["readme.md", "auth.md", "api.md"]) {
      const fullPath = join(docsDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const hash = require("crypto").createHash("sha256").update(content).digest("hex");
      const title = content.match(/^#\s+(.+)/m)?.[1] || file;

      internal.insertContent(hash, content, now);
      internal.insertDocument("docs", `qmd://docs/${file}`, title, hash, now, now);
    }
  });

  afterAll(async () => {
    await store.close();
  });

  test("get retrieves a document by path", async () => {
    const result = await store.get("qmd://docs/auth.md");

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.title).toBe("Authentication");
      expect(result.collectionName).toBe("docs");
    }
  });

  test("get with includeBody returns body content", async () => {
    const result = await store.get("qmd://docs/auth.md", { includeBody: true });

    if (!("error" in result)) {
      expect(result.body).toBeDefined();
      expect(result.body).toContain("JWT tokens");
    }
  });

  test("get returns not_found for missing document", async () => {
    const result = await store.get("qmd://docs/nonexistent.md");

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("not_found");
    }
  });

  test("get by docid", async () => {
    // First get a document to find its docid
    const doc = await store.get("qmd://docs/readme.md");
    if (!("error" in doc)) {
      const byDocid = await store.get(`#${doc.docid}`);
      expect("error" in byDocid).toBe(false);
      if (!("error" in byDocid)) {
        expect(byDocid.docid).toBe(doc.docid);
      }
    }
  });

  test("multiGet retrieves a document by docid", async () => {
    const doc = await store.get("qmd://docs/readme.md");
    if (!("error" in doc)) {
      const { docs, errors } = await store.multiGet(`#${doc.docid}`, { includeBody: true });
      expect(errors).toHaveLength(0);
      expect(docs).toHaveLength(1);
      expect(docs[0]!.doc.docid).toBe(doc.docid);
      expect(docs[0]!.skipped).toBe(false);
      if (!docs[0]!.skipped) {
        expect(docs[0]!.doc.body).toContain("getting started guide");
      }
    }
  });

  test("multiGet retrieves multiple documents", async () => {
    const { docs, errors } = await store.multiGet("qmd://docs/*.md");
    expect(docs.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Index Health Tests
// =============================================================================

describe("index health", () => {
  let store: QMDStore;

  beforeEach(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });
  });

  afterEach(async () => {
    await store.close();
  });

  test("getStatus returns valid structure", async () => {
    const status = await store.getStatus();

    expect(status).toHaveProperty("totalDocuments");
    expect(status).toHaveProperty("needsEmbedding");
    expect(status).toHaveProperty("hasVectorIndex");
    expect(status).toHaveProperty("collections");
    expect(typeof status.totalDocuments).toBe("number");
  });

  test("getIndexHealth returns valid structure", async () => {
    const health = await store.getIndexHealth();

    expect(health).toHaveProperty("needsEmbedding");
    expect(health).toHaveProperty("totalDocs");
    expect(typeof health.needsEmbedding).toBe("number");
    expect(typeof health.totalDocs).toBe("number");
  });

  test("fresh store has zero documents", async () => {
    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(0);
  });
});

// =============================================================================
// Update Tests
// =============================================================================

describe("update", () => {
  test("indexes files and returns correct stats", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await store.update();

    expect(result.collections).toBe(1);
    expect(result.indexed).toBe(3); // readme.md, auth.md, api.md
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(typeof result.needsEmbedding).toBe("number");

    await store.close();
  });

  test("second update shows unchanged files", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();
    const result = await store.update();

    expect(result.indexed).toBe(0);
    expect(result.unchanged).toBe(3);

    await store.close();
  });

  test("update with onProgress callback fires", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const progress: UpdateProgress[] = [];
    await store.update({
      onProgress: (info) => progress.push(info),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]!.collection).toBe("docs");
    expect(progress[0]!.current).toBeGreaterThanOrEqual(1);
    expect(progress[0]!.total).toBe(3);

    await store.close();
  });

  test("update with collection filter", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await store.update({ collections: ["docs"] });

    expect(result.collections).toBe(1);
    expect(result.indexed).toBe(3); // Only docs

    await store.close();
  });

  test("update multiple collections", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await store.update();

    expect(result.collections).toBe(2);
    expect(result.indexed).toBe(6); // 3 docs + 3 notes

    await store.close();
  });

  test("documents are searchable after update", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();

    const results = await store.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);

    await store.close();
  });
});

describe("embed", () => {
  function createFakeTokenizer() {
    return {
      async tokenize(text: string) {
        return new Array(Math.max(1, Math.ceil(text.length / 16))).fill(1);
      },
    };
  }

  function createFakeEmbedLlm() {
    const embedBatchCalls: string[][] = [];
    return {
      embedBatchCalls,
      async embed(_text: string) {
        return { embedding: [0.1, 0.2, 0.3], model: "fake-embed" };
      },
      async embedBatch(texts: string[]) {
        embedBatchCalls.push([...texts]);
        return texts.map((_text, index) => ({
          embedding: [index + 1, index + 2, index + 3],
          model: "fake-embed",
        }));
      },
    };
  }

  test("projected sync embeds only pending content and removes stale rows without breaking shared embeddings", async () => {
    const store = await createStore({ dbPath: freshDbPath(), config: {
      collections: { projected: { projected: true }, retained: { projected: true } },
    } });
    Object.assign(store.internal.llm!, createFakeTokenizer(), createFakeEmbedLlm());
    const keep = { path: "keep.md", content: "shared log" };
    const remove = { path: "remove.md", content: "revoked log" };
    try {
      const shared = await store.upsertDocument("retained", "also.md", keep.content);
      const first = await store.syncProjectedCollection("projected", [keep, remove], { embed: true, chunkStrategy: "semantic" });
      expect(first).toEqual({ upserted: 2, unchanged: 0, retracted: 0, embedded: 2, generation: 1 });
      expect(await store.syncProjectedCollection("projected", [keep, remove], { embed: true })).toEqual({
        upserted: 0, unchanged: 2, retracted: 0, embedded: 0, generation: 1,
      });
      expect(await store.syncProjectedCollection("projected", [], { cleanup: false })).toEqual({
        upserted: 0, unchanged: 0, retracted: 2, embedded: 0, generation: 2,
      });
      const db = store.internal.db;
      expect(db.prepare("SELECT hash FROM content_vectors ORDER BY hash").all()).toHaveLength(2);
      expect(await store.syncProjectedCollection("projected", [])).toEqual({
        upserted: 0, unchanged: 0, retracted: 0, embedded: 0, generation: 3,
      });
      expect(db.prepare("SELECT hash FROM content").all()).toEqual([{ hash: shared.hash }]);
      expect(db.prepare("SELECT hash FROM content_vectors").all()).toEqual([{ hash: shared.hash }]);
      expect(db.prepare("SELECT hash_seq FROM vectors_vec").all()).toEqual([{ hash_seq: `${shared.hash}_0` }]);
      expect(await store.getDocumentBody("qmd://retained/also.md")).toBe(keep.content);
      expect((await store.syncProjectedCollection("projected", [])).generation).toBe(3);
      expect(await store.getCollectionGeneration("retained")).toBe(shared.generation);
    } finally {
      await store.close();
    }
  });

  test("store.embed forwards batch limit options", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const fakeLlm = createFakeEmbedLlm();
    setDefaultLlamaCpp(createFakeTokenizer() as any);
    Object.assign(store.internal.llm!, fakeLlm);

    try {
      await store.update();
      const result = await store.embed({
        maxDocsPerBatch: 1,
        maxBatchBytes: 1024 * 1024,
      });

      expect(fakeLlm.embedBatchCalls).toHaveLength(3);
      expect(fakeLlm.embedBatchCalls.map(call => call.length)).toEqual([1, 1, 1]);
      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });

  test("store.embed scopes pending documents to the requested collection", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const fakeLlm = createFakeEmbedLlm();
    setDefaultLlamaCpp(createFakeTokenizer() as any);
    Object.assign(store.internal.llm!, fakeLlm);

    try {
      await store.update();
      const result = await store.embed({ collection: "docs" });

      const vectorCounts = store.internal.db.prepare(`
        SELECT d.collection, COUNT(DISTINCT v.hash) AS count
        FROM documents d
        LEFT JOIN content_vectors v ON v.hash = d.hash AND v.seq = 0
        WHERE d.active = 1
        GROUP BY d.collection
        ORDER BY d.collection
      `).all() as Array<{ collection: string; count: number }>;

      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
      expect(vectorCounts).toEqual([
        { collection: "docs", count: 3 },
        { collection: "notes", count: 0 },
      ]);
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });

  test("store.embed with force only clears the requested collection", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const fakeLlm = createFakeEmbedLlm();
    setDefaultLlamaCpp(createFakeTokenizer() as any);
    Object.assign(store.internal.llm!, fakeLlm);

    const vectorCounts = () => store.internal.db.prepare(`
      SELECT d.collection, COUNT(DISTINCT v.hash) AS count
      FROM documents d
      LEFT JOIN content_vectors v ON v.hash = d.hash AND v.seq = 0
      WHERE d.active = 1
      GROUP BY d.collection
      ORDER BY d.collection
    `).all() as Array<{ collection: string; count: number }>;

    try {
      await store.update();
      await store.embed();
      expect(vectorCounts()).toEqual([
        { collection: "docs", count: 3 },
        { collection: "notes", count: 3 },
      ]);

      const result = await store.embed({ force: true, collection: "docs" });

      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
      expect(vectorCounts()).toEqual([
        { collection: "docs", count: 3 },
        { collection: "notes", count: 3 },
      ]);
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });

  test("store.embed rejects invalid batch limits", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    try {
      await expect(store.embed({ maxDocsPerBatch: 0 })).rejects.toThrow("maxDocsPerBatch");
      await expect(store.embed({ maxBatchBytes: 0 })).rejects.toThrow("maxBatchBytes");
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });
});

// =============================================================================
// Lifecycle Tests
// =============================================================================

describe("lifecycle", () => {
  test("close() is async and does not throw", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    // close() should return a promise
    const result = store.close();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  test("close() makes subsequent operations throw", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await store.close();

    // Database operations should fail after close
    await expect(store.getStatus()).rejects.toThrow();
  });

  test("multiple stores can coexist with different databases", async () => {
    const store1 = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    // Note: since config source is module-level, we close store1 first
    await store1.close();

    const store2 = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const names = (await store2.listCollections()).map(c => c.name);
    expect(names).toContain("notes");
    expect(names).not.toContain("docs");

    await store2.close();
  });
});

// =============================================================================
// Config Initialization Tests
// =============================================================================

describe("config initialization", () => {
  test("inline config with global_context is preserved", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        global_context: "System knowledge base",
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const global = await store.getGlobalContext();
    expect(global).toBe("System knowledge base");
    await store.close();
  });

  test("inline config with pre-existing contexts is preserved", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: {
            path: docsDir,
            pattern: "**/*.md",
            context: { "/auth": "Authentication docs" },
          },
        },
      },
    });

    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/auth",
      context: "Authentication docs",
    });
    await store.close();
  });

  test("inline config with empty collections object works", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    expect(await store.listCollections()).toEqual([]);
    expect(await store.listContexts()).toEqual([]);
    await store.close();
  });

  test("inline config with multiple collection options", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: {
            path: docsDir,
            pattern: "**/*.md",
            ignore: ["drafts/**"],
            includeByDefault: true,
          },
          notes: {
            path: notesDir,
            pattern: "**/*.md",
            includeByDefault: false,
          },
        },
      },
    });

    const collections = await store.listCollections();
    expect(collections).toHaveLength(2);
    await store.close();
  });
});

// =============================================================================
// SDK surface checks (consumer types are checked in sdk.types.ts)
// =============================================================================

describe("SDK surface", () => {
  test("QMDStore type exposes expected methods", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    // Verify all methods exist
    expect(typeof store.search).toBe("function");
    expect(typeof store.searchLex).toBe("function");
    expect(typeof store.searchVector).toBe("function");
    expect(typeof store.vsearch).toBe("function");
    expect(typeof store.expandQuery).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.multiGet).toBe("function");
    expect(typeof store.addCollection).toBe("function");
    expect(typeof store.removeCollection).toBe("function");
    expect(typeof store.renameCollection).toBe("function");
    expect(typeof store.listCollections).toBe("function");
    expect(typeof store.addContext).toBe("function");
    expect(typeof store.removeContext).toBe("function");
    expect(typeof store.setGlobalContext).toBe("function");
    expect(typeof store.getGlobalContext).toBe("function");
    expect(typeof store.listContexts).toBe("function");
    expect(typeof store.getStatus).toBe("function");
    expect(typeof store.getIndexHealth).toBe("function");
    expect(typeof store.update).toBe("function");
    expect(typeof store.embed).toBe("function");
    expect(typeof store.close).toBe("function");

    await store.close();
  });

  test("vsearch delegates safely when no vector index exists", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await expect(store.vsearch("remember this", { expand: false })).resolves.toEqual([]);

    await store.close();
  });
});

// =============================================================================
// DB-Only Mode Tests (self-contained store)
// =============================================================================

describe("DB-only mode", () => {
  test("reopen store with just dbPath after config+update session", async () => {
    const dbPath = freshDbPath();

    // Session 1: create store with config, update, close
    const store1 = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
        global_context: "Test knowledge base",
      },
    });

    await store1.update();

    // Verify documents indexed
    const status1 = await store1.getStatus();
    expect(status1.totalDocuments).toBe(6);
    await store1.close();

    // Session 2: reopen with just dbPath — no config
    const store2 = await createStore({ dbPath } as StoreOptions);

    // Collections should still be available
    const collections = await store2.listCollections();
    expect(collections.map(c => c.name).sort()).toEqual(["docs", "notes"]);

    // Search should still work
    const results = await store2.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);

    // Global context should still be available
    const globalCtx = await store2.getGlobalContext();
    expect(globalCtx).toBe("Test knowledge base");

    // Contexts from collections should persist
    const status2 = await store2.getStatus();
    expect(status2.totalDocuments).toBe(6);

    await store2.close();
  });

  test("config sync populates store_collections table", async () => {
    const dbPath = freshDbPath();
    const store = await createStore({
      dbPath,
      config: {
        collections: {
          docs: {
            path: docsDir,
            pattern: "**/*.md",
            context: { "/auth": "Auth documentation" },
          },
        },
      },
    });

    // Verify collections are in the DB via listCollections
    const collections = await store.listCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe("docs");
    expect(collections[0]!.pwd).toBe(docsDir);

    // Verify contexts are accessible
    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/auth",
      context: "Auth documentation",
    });

    await store.close();
  });

  test("config hash skip: second init with same config skips sync", async () => {
    const dbPath = freshDbPath();
    const config = {
      collections: {
        docs: { path: docsDir, pattern: "**/*.md" },
      },
    };

    // First init — syncs config
    const store1 = await createStore({ dbPath, config });
    await store1.close();

    // Second init with same config — should skip sync (no-op, but should not error)
    const store2 = await createStore({ dbPath, config });
    const collections = await store2.listCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe("docs");
    await store2.close();
  });

  test("DB-only mode supports collection mutations", async () => {
    const dbPath = freshDbPath();

    // Session 1: create with config
    const store1 = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });
    await store1.close();

    // Session 2: reopen DB-only, add a collection
    const store2 = await createStore({ dbPath } as StoreOptions);
    await store2.addCollection("notes", { path: notesDir, pattern: "**/*.md" });

    const names = (await store2.listCollections()).map(c => c.name).sort();
    expect(names).toEqual(["docs", "notes"]);

    await store2.close();

    // Session 3: reopen DB-only again, verify both collections persist
    const store3 = await createStore({ dbPath } as StoreOptions);
    const names3 = (await store3.listCollections()).map(c => c.name).sort();
    expect(names3).toEqual(["docs", "notes"]);
    await store3.close();
  });

  test("DB-only mode supports context mutations", async () => {
    const dbPath = freshDbPath();

    // Session 1: create with config
    const store1 = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });
    await store1.addContext("docs", "/api", "API docs");
    await store1.setGlobalContext("Global context");
    await store1.close();

    // Session 2: reopen DB-only
    const store2 = await createStore({ dbPath } as StoreOptions);

    const contexts = await store2.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/api",
      context: "API docs",
    });
    expect(contexts).toContainEqual({
      collection: "*",
      path: "/",
      context: "Global context",
    });

    await store2.close();
  });
});
