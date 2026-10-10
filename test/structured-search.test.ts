/**
 * structured-search.test.ts - Tests for structured search functionality
 *
 * Tests cover:
 * - ExpandedQuery type validation
 * - Basic structuredSearch function behavior
 *
 * Run with: bun test structured-search.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  structuredSearch,
  validateSemanticQuery,
  validateLexQuery,
  type ExpandedQuery,
  type Store,
} from "../src/store.js";
import { disposeDefaultLlamaCpp } from "../src/llm.js";


// =============================================================================
// ExpandedQuery Type Tests
// =============================================================================

describe("ExpandedQuery type", () => {
  test("accepts lex type", () => {
    const search: ExpandedQuery = { type: "lex", query: "test" };
    expect(search.type).toBe("lex");
    expect(search.query).toBe("test");
  });

  test("accepts vec type", () => {
    const search: ExpandedQuery = { type: "vec", query: "test" };
    expect(search.type).toBe("vec");
    expect(search.query).toBe("test");
  });

  test("accepts hyde type", () => {
    const search: ExpandedQuery = { type: "hyde", query: "test" };
    expect(search.type).toBe("hyde");
    expect(search.query).toBe("test");
  });
});

// =============================================================================
// structuredSearch Function Tests
// =============================================================================

describe("structuredSearch", () => {
  let testDir: string;
  let store: Store;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-structured-test-"));
    const testDbPath = join(testDir, "test.sqlite");
    const testConfigDir = await mkdtemp(join(testDir, "config-"));
    process.env.QMD_CONFIG_DIR = testConfigDir;
    store = createStore(testDbPath);
  });

  afterAll(async () => {
    store.close();
    await disposeDefaultLlamaCpp();
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("returns empty array for empty searches", async () => {
    const results = await structuredSearch(store, []);
    expect(results).toEqual([]);
  });

  test("returns empty array when no documents match", async () => {
    const results = await structuredSearch(store, [
      { type: "lex", query: "nonexistent-term-xyz123" }
    ], { skipRerank: true });
    expect(results).toEqual([]);
  });

  test("accepts all search types without error", async () => {
    // These may return empty results but should not throw
    await expect(structuredSearch(store, [{ type: "lex", query: "test" }], { skipRerank: true })).resolves.toBeDefined();
    // vec and hyde require embeddings, so just test lex
  });

  test("respects limit option", async () => {
    const results = await structuredSearch(store, [
      { type: "lex", query: "test" }
    ], { limit: 5, skipRerank: true });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test("respects minScore option", async () => {
    const results = await structuredSearch(store, [
      { type: "lex", query: "test" }
    ], { minScore: 0.5, skipRerank: true });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  test("throws when lex query contains newline characters", async () => {
    await expect(structuredSearch(store, [
      { type: "lex", query: "foo\nbar", line: 3 }
    ])).rejects.toThrow(/Line 3 \(lex\):/);
  });

  test("throws when lex query has unmatched quote", async () => {
    await expect(structuredSearch(store, [
      { type: "lex", query: "\"unfinished phrase", line: 2 }
    ])).rejects.toThrow(/unmatched double quote/);
  });
});

// =============================================================================
// FTS Query Syntax Tests
// =============================================================================

describe("lex query syntax", () => {
  // Note: These test via CLI behavior since buildFTS5Query is not exported

  describe("validateSemanticQuery", () => {

    test("accepts plain natural language", () => {
      expect(validateSemanticQuery("how does error handling work")).toBeNull();
      expect(validateSemanticQuery("what is the CAP theorem")).toBeNull();
    });

    test("rejects negation at start of query", () => {
      expect(validateSemanticQuery("-redis connection pooling")).toContain("Negation");
    });

    test("rejects negation after space", () => {
      expect(validateSemanticQuery("performance -sports")).toContain("Negation");
    });

    test("rejects negated quoted phrase", () => {
      expect(validateSemanticQuery('-"exact phrase"')).toContain("Negation");
    });

    test("rejects multiple negations", () => {
      expect(validateSemanticQuery("error handling -java -python")).toContain("Negation");
    });

    test("rejects negation after leading whitespace", () => {
      expect(validateSemanticQuery("  -term at start")).toContain("Negation");
    });

    test("rejects negation after tab", () => {
      expect(validateSemanticQuery("foo\t-bar")).toContain("Negation");
    });

    test("accepts hyphenated compound words", () => {
      expect(validateSemanticQuery("long-lived server shared across clients")).toBeNull();
      expect(validateSemanticQuery("real-time voice processing pipeline")).toBeNull();
      expect(validateSemanticQuery("how does the rate-limiter handle burst traffic")).toBeNull();
      expect(validateSemanticQuery("self-hosted deployment options")).toBeNull();
      expect(validateSemanticQuery("multi-client session architecture")).toBeNull();
      expect(validateSemanticQuery("cross-platform compatibility")).toBeNull();
      expect(validateSemanticQuery("non-blocking I/O model")).toBeNull();
      expect(validateSemanticQuery("in-memory caching strategy")).toBeNull();
      expect(validateSemanticQuery("write-ahead log for crash recovery")).toBeNull();
      expect(validateSemanticQuery("copy-on-write semantics")).toBeNull();
    });

    test("accepts multiple hyphens in a phrase", () => {
      expect(validateSemanticQuery("state-of-the-art embedding models")).toBeNull();
      expect(validateSemanticQuery("end-to-end testing")).toBeNull();
      expect(validateSemanticQuery("man-in-the-middle attack prevention")).toBeNull();
    });

    test("accepts multiple hyphenated words in one query", () => {
      expect(validateSemanticQuery("built-in vs add-on features")).toBeNull();
    });

    test("accepts short hyphenated terms", () => {
      expect(validateSemanticQuery("A-B testing for ML models")).toBeNull();
      expect(validateSemanticQuery("e-commerce platform")).toBeNull();
    });

    test("accepts bare hyphen without word character", () => {
      expect(validateSemanticQuery("-")).toBeNull();
    });

    test("accepts hyde-style hypothetical answers", () => {
      expect(validateSemanticQuery(
        "The CAP theorem states that a distributed system cannot simultaneously provide consistency, availability, and partition tolerance."
      )).toBeNull();
    });

    test("accepts hyde with hyphenated words", () => {
      expect(validateSemanticQuery(
        "HTTP transport runs a single long-lived daemon shared across all clients, avoiding per-session model re-loading."
      )).toBeNull();
    });
  });

  describe("validateLexQuery", () => {
    test("accepts basic lex query", () => {
      expect(validateLexQuery("auth token")).toBeNull();
    });

    test("rejects newline", () => {
      expect(validateLexQuery("foo\nbar")).toContain("single line");
    });

    test("rejects unmatched quote", () => {
      expect(validateLexQuery("\"unfinished")).toContain("unmatched");
    });
  });
});
