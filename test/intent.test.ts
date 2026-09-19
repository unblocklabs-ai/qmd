/**
 * intent.test.ts - Tests for the intent feature
 *
 * Tests cover:
 * - extractIntentTerms: stop word filtering, punctuation, acronyms, edge cases
 * - extractSnippet with intent: disambiguation across multiple document sections
 * - parseStructuredQuery with intent: lines (parsing, validation, error cases)
 * - Chunk selection scoring with intent
 * - Strong-signal bypass when intent is present
 * - Intent constants
 *
 * Run with: npx vitest run test/intent.test.ts
 */

import { describe, test, expect } from "vitest";
import {
  extractSnippet,
  extractIntentTerms,
  INTENT_WEIGHT_SNIPPET,
  type ExpandedQuery,
} from "../src/store.js";

// =============================================================================
// parseStructuredQuery — duplicated from src/cli/qmd.ts for unit testing
// (qmd.ts doesn't export it since it's a CLI internal)
// =============================================================================

interface ParsedStructuredQuery {
  searches: ExpandedQuery[];
  intent?: string;
}

function parseStructuredQuery(query: string): ParsedStructuredQuery | null {
  const rawLines = query.split('\n').map((line, idx) => ({
    raw: line,
    trimmed: line.trim(),
    number: idx + 1,
  })).filter(line => line.trimmed.length > 0);

  if (rawLines.length === 0) return null;

  const prefixRe = /^(lex|vec|hyde):\s*/i;
  const expandRe = /^expand:\s*/i;
  const intentRe = /^intent:\s*/i;
  const typed: ExpandedQuery[] = [];
  let intent: string | undefined;

  for (const line of rawLines) {
    if (expandRe.test(line.trimmed)) {
      if (rawLines.length > 1) {
        throw new Error(`Line ${line.number} starts with expand:, but query documents cannot mix expand with typed lines. Submit a single expand query instead.`);
      }
      const text = line.trimmed.replace(expandRe, '').trim();
      if (!text) {
        throw new Error('expand: query must include text.');
      }
      return null;
    }

    if (intentRe.test(line.trimmed)) {
      if (intent !== undefined) {
        throw new Error(`Line ${line.number}: only one intent: line is allowed per query document.`);
      }
      const text = line.trimmed.replace(intentRe, '').trim();
      if (!text) {
        throw new Error(`Line ${line.number}: intent: must include text.`);
      }
      intent = text;
      continue;
    }

    const match = line.trimmed.match(prefixRe);
    if (match) {
      const type = match[1]!.toLowerCase() as 'lex' | 'vec' | 'hyde';
      const text = line.trimmed.slice(match[0].length).trim();
      if (!text) {
        throw new Error(`Line ${line.number} (${type}:) must include text.`);
      }
      if (/\r|\n/.test(text)) {
        throw new Error(`Line ${line.number} (${type}:) contains a newline. Keep each query on a single line.`);
      }
      typed.push({ type, query: text, line: line.number });
      continue;
    }

    if (rawLines.length === 1) {
      return null;
    }

    throw new Error(`Line ${line.number} is missing a lex:/vec:/hyde:/intent: prefix. Each line in a query document must start with one.`);
  }

  if (intent && typed.length === 0) {
    throw new Error('intent: cannot appear alone. Add at least one lex:, vec:, or hyde: line.');
  }

  return typed.length > 0 ? { searches: typed, intent } : null;
}

// =============================================================================
// extractIntentTerms
// =============================================================================

describe("extractIntentTerms", () => {
  test("filters stop words", () => {
    // "looking", "for", "notes", "about" are stop words
    expect(extractIntentTerms("looking for notes about latency optimization"))
      .toEqual(["latency", "optimization"]);
  });

  test("filters common function words", () => {
    // "what", "is", "the", "to", "find" are stop words; "best", "way" survive
    expect(extractIntentTerms("what is the best way to find"))
      .toEqual(["best", "way"]);
  });

  test("preserves domain terms", () => {
    expect(extractIntentTerms("web performance latency page load times"))
      .toEqual(["web", "performance", "latency", "page", "load", "times"]);
  });

  test("handles surrounding punctuation with Unicode awareness", () => {
    expect(extractIntentTerms("personal health, fitness, and endurance"))
      .toEqual(["personal", "health", "fitness", "endurance"]);
  });

  test("preserves internal hyphens", () => {
    expect(extractIntentTerms("self-hosted real-time (decision-making)"))
      .toEqual(["self-hosted", "real-time", "decision-making"]);
  });

  test("short domain terms survive (API, SQL, LLM)", () => {
    expect(extractIntentTerms("API design for LLM agents"))
      .toEqual(["api", "design", "llm", "agents"]);
  });

  test("returns empty for empty input", () => {
    expect(extractIntentTerms("")).toEqual([]);
    expect(extractIntentTerms("  ")).toEqual([]);
  });

  test("filters single-char terms", () => {
    const terms = extractIntentTerms("a b c web");
    expect(terms).toEqual(["web"]);
  });

  test("all stop words returns empty", () => {
    const terms = extractIntentTerms("the and or but in on at to for of with by");
    expect(terms).toEqual([]);
  });

  test("preserves 2-char domain terms (CI, CD, DB)", () => {
    const terms = extractIntentTerms("SQL CI CD DB");
    expect(terms).toContain("sql");
    expect(terms).toContain("ci");
    expect(terms).toContain("cd");
    expect(terms).toContain("db");
  });

  test("lowercases all terms", () => {
    const terms = extractIntentTerms("WebSocket HTTP REST");
    expect(terms).toContain("websocket");
    expect(terms).toContain("http");
    expect(terms).toContain("rest");
  });

  test("handles C++ style punctuation", () => {
    const terms = extractIntentTerms("C++, performance! optimization.");
    expect(terms).toContain("performance");
    expect(terms).toContain("optimization");
  });
});

// =============================================================================
// extractSnippet with intent — disambiguation
// =============================================================================

describe("extractSnippet with intent", () => {
  // Each section contains "performance" so the query score is tied (1.0 each).
  // Intent terms (INTENT_WEIGHT_SNIPPET) then break the tie toward the relevant section.
  const body = [
    "# Notes on Various Topics",
    "",
    "## Web Performance Section",
    "Web performance means optimizing page load times and Core Web Vitals.",
    "Reduce latency, improve rendering speed, and measure performance budgets.",
    "",
    "## Team Performance Section",
    "Team performance depends on trust, psychological safety, and feedback.",
    "Build culture where performance reviews drive growth not fear.",
    "",
    "## Health Performance Section",
    "Health performance comes from consistent exercise, sleep, and endurance.",
    "Track fitness metrics, optimize recovery, and monitor healthspan.",
  ].join("\n");

  test("without intent, anchors on query terms only", () => {
    const result = extractSnippet(body, "performance", 500);
    // "performance" appears in title and multiple sections — should anchor on first match
    expect(result.snippet).toContain("Performance");
  });

  test("with web-perf intent, prefers web performance section", () => {
    const result = extractSnippet(
      body, "performance", 500,
      undefined, undefined,
      "Looking for notes about web performance, latency, and page load times"
    );
    expect(result.snippet).toMatch(/latency|page.*load|Core Web Vitals/i);
  });

  test("with health intent, prefers health section", () => {
    const result = extractSnippet(
      body, "performance", 500,
      undefined, undefined,
      "Looking for notes about personal health, fitness, and endurance"
    );
    expect(result.snippet).toMatch(/health|fitness|endurance|exercise/i);
  });

  test("with team intent, prefers team section", () => {
    const result = extractSnippet(
      body, "performance", 500,
      undefined, undefined,
      "Looking for notes about building high-performing teams and culture"
    );
    expect(result.snippet).toMatch(/team|culture|trust|feedback/i);
  });

  test("intent does not override strong query match", () => {
    // Query "Core Web Vitals" is very specific — intent shouldn't pull away from it
    const result = extractSnippet(
      body, "Core Web Vitals", 500,
      undefined, undefined,
      "Looking for notes about health and fitness"
    );
    expect(result.snippet).toContain("Core Web Vitals");
  });

  test("absent intent produces same result as undefined", () => {
    const withoutIntent = extractSnippet(body, "performance", 500);
    const withUndefined = extractSnippet(body, "performance", 500, undefined, undefined, undefined);
    expect(withoutIntent.line).toBe(withUndefined.line);
    expect(withoutIntent.snippet).toBe(withUndefined.snippet);
  });

  test("intent with no matching terms falls back to query-only scoring", () => {
    const result = extractSnippet(
      body, "performance", 500,
      undefined, undefined,
      "quantum computing and entanglement"
    );
    expect(result.snippet).toContain("Performance");
    expect(result.snippet.length).toBeGreaterThan(0);
  });

  test("intent works with chunk position", () => {
    const webPerfStart = body.indexOf("## Web Performance");
    const result = extractSnippet(
      body, "performance", 500,
      webPerfStart, 200,
      "web page load times"
    );
    expect(result.snippet).toMatch(/Web Performance|Core Web Vitals|Page load/i);
  });
});

// =============================================================================
// extractSnippet — intent weight verification
// =============================================================================

describe("extractSnippet intent weight behavior", () => {
  // Document where query term appears on every line but intent terms differ
  const body = [
    "performance metrics for team velocity",
    "performance metrics for web latency",
    "performance metrics for athletic endurance",
  ].join("\n");

  test("intent breaks tie when query matches all lines equally", () => {
    const noIntent = extractSnippet(body, "performance metrics", 500);
    // Without intent, first line wins (all equal score)
    expect(noIntent.line).toBe(1);

    const withIntent = extractSnippet(
      body, "performance metrics", 500,
      undefined, undefined,
      "web latency and page speed"
    );
    // Intent terms "web", "latency" match line 2
    expect(withIntent.snippet).toContain("web latency");
  });
});

// =============================================================================
// parseStructuredQuery with intent
// =============================================================================

describe("parseStructuredQuery with intent", () => {
  test("parses intent + lex query", () => {
    const result = parseStructuredQuery("intent: web performance\nlex: performance");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("web performance");
    expect(result!.searches).toHaveLength(1);
    expect(result!.searches[0]!.type).toBe("lex");
    expect(result!.searches[0]!.query).toBe("performance");
  });

  test("parses intent + multiple typed lines", () => {
    const result = parseStructuredQuery(
      "intent: web page load times\nlex: performance\nvec: how to improve performance"
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("web page load times");
    expect(result!.searches).toHaveLength(2);
    expect(result!.searches[0]!.type).toBe("lex");
    expect(result!.searches[1]!.type).toBe("vec");
  });

  test("intent can appear after typed lines", () => {
    const result = parseStructuredQuery(
      "lex: performance\nintent: web page load times\nvec: latency"
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("web page load times");
    expect(result!.searches).toHaveLength(2);
  });

  test("intent is case-insensitive prefix", () => {
    const result = parseStructuredQuery("Intent: web perf\nlex: performance");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("web perf");
  });

  test("no intent returns undefined", () => {
    const result = parseStructuredQuery("lex: performance\nvec: speed");
    expect(result).not.toBeNull();
    expect(result!.intent).toBeUndefined();
  });

  test("intent alone throws error", () => {
    expect(() => parseStructuredQuery("intent: web performance")).toThrow(
      /intent: cannot appear alone/
    );
  });

  test("multiple intent lines throw error", () => {
    expect(() =>
      parseStructuredQuery("intent: web perf\nintent: team health\nlex: performance")
    ).toThrow(/only one intent: line is allowed/);
  });

  test("empty intent text throws error", () => {
    expect(() =>
      parseStructuredQuery("intent:\nlex: performance")
    ).toThrow(/intent: must include text/);
  });

  test("intent with whitespace-only text throws error", () => {
    expect(() =>
      parseStructuredQuery("intent:   \nlex: performance")
    ).toThrow(/intent: must include text/);
  });

  test("single plain line still returns null (expand mode)", () => {
    const result = parseStructuredQuery("how does auth work");
    expect(result).toBeNull();
  });

  test("expand: line still returns null", () => {
    const result = parseStructuredQuery("expand: auth stuff");
    expect(result).toBeNull();
  });

  test("intent with expand throws error (expand can't mix)", () => {
    expect(() =>
      parseStructuredQuery("intent: web\nexpand: performance")
    ).toThrow(/cannot mix expand/);
  });

  test("empty query returns null", () => {
    expect(parseStructuredQuery("")).toBeNull();
    expect(parseStructuredQuery("  \n  \n  ")).toBeNull();
  });

  test("intent with blank lines is fine", () => {
    const result = parseStructuredQuery(
      "intent: web perf\n\nlex: performance\n\nvec: speed"
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("web perf");
    expect(result!.searches).toHaveLength(2);
  });

  test("intent preserves full text including colons", () => {
    const result = parseStructuredQuery(
      "intent: web performance: LCP, FID, CLS\nlex: performance"
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("web performance: LCP, FID, CLS");
  });
});

// =============================================================================
// Constants exported
// =============================================================================

describe("intent constants", () => {
  test("INTENT_WEIGHT_SNIPPET is 0.3", () => {
    expect(INTENT_WEIGHT_SNIPPET).toBe(0.3);
  });


});
