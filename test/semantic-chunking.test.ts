import { describe, expect, test } from "vitest";
import {
  assembleSemanticChunks,
  chunkMarkdownSemantically,
  cosineSimilarity,
  localSimilarityScores,
  scanMarkdownAtoms,
  type SemanticChunkOptions,
} from "../src/semantic-chunking.js";

const countWords = async (text: string): Promise<number> => text.trim().split(/\s+/).filter(Boolean).length;

function topicalVector(text: string): readonly number[] {
  if (/database|index|query/i.test(text)) return [0, 1];
  return [1, 0];
}

function options(overrides: Partial<SemanticChunkOptions> = {}): SemanticChunkOptions {
  return {
    minTokens: 8,
    maxTokens: 20,
    similarityWindow: 2,
    thresholdStep: 0.01,
    thresholdTolerance: 1,
    embeddingBatchSize: 64,
    countTokens: countWords,
    embedBatch: async texts => texts.map(topicalVector),
    ...overrides,
  };
}

describe("semantic chunking math", () => {
  test("computes cosine similarity and local window-mean scores", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(localSimilarityScores([[1, 0], [1, 0], [0, 1]], 2)).toEqual([1, 0]);
  });

  test("splits at the first post-topic decline and soft-min suppresses the next decline", async () => {
    const texts = ["old one ", "old two ", "new one ", "new two ", "new three"];
    const content = texts.join("");
    let pos = 0;
    const atoms = texts.map(text => {
      const start = pos;
      pos += text.length;
      return { text, start, end: pos, tokens: 2, boundaryBefore: "none" as const };
    });

    const chunks = await assembleSemanticChunks(
      content,
      atoms,
      [0.9, 0.4, 0.3, 0.9],
      0.5,
      { minTokens: 4, maxTokens: 20, countTokens: countWords },
    );

    expect(chunks.map(chunk => chunk.text)).toEqual([
      "old one old two ",
      "new one new two new three",
    ]);
  });
});

describe("Markdown and journal boundaries", () => {
  test("keeps sparse, unrelated journal events independent", async () => {
    const content = [
      "Decision: Use SQLite for the local cache.\n",
      "\n",
      "Preference: Keep status messages short.\n",
      "\n",
      "Outcome: The deployment completed successfully.\n",
    ].join("");
    let embeddingCalls = 0;
    const chunks = await chunkMarkdownSemantically(content, "2026-08-23.md", options({
      embedBatch: async texts => {
        embeddingCalls++;
        return texts.map(topicalVector);
      },
    }));

    expect(chunks.map(chunk => chunk.text.trim())).toEqual([
      "Decision: Use SQLite for the local cache.",
      "Preference: Keep status messages short.",
      "Outcome: The deployment completed successfully.",
    ]);
    expect(embeddingCalls).toBe(0);
  });

  test("detects journal markers in a non-date filename", async () => {
    const content = "Task: repair indexing\n\nObservation: the cache is stale\n";
    const atoms = await scanMarkdownAtoms(content, "notes.md", countWords);

    expect(atoms).toHaveLength(2);
    expect(atoms.map(atom => atom.boundaryBefore)).toEqual(["event", "event"]);
  });

  test("treats projected transcript timestamps with seconds as hard events", async () => {
    const content = [
      "2026-08-25 14:32:09 UTC — Rico: Can you review memory?\n\n",
      "2026-08-25 14:33:02 UTC — Bill: Yes, I can review it.\n",
    ].join("");
    const atoms = await scanMarkdownAtoms(content, "session.md", countWords);

    expect(atoms).toHaveLength(2);
    expect(atoms.map(atom => atom.boundaryBefore)).toEqual(["event", "event"]);
  });

  test("does not change ordinary list boundaries based on a date-shaped filename", async () => {
    const content = [
      "- Cats sleep beside warm windows and chase toys.\n",
      "- Cats purr beside their people and nap quietly.\n",
    ].join("");

    const dated = await chunkMarkdownSemantically(content, "2026-08-23.md", options({ maxTokens: 100 }));
    const named = await chunkMarkdownSemantically(content, "notes.md", options({ maxTokens: 100 }));

    expect(dated).toEqual(named);
    expect(dated).toHaveLength(1);
  });

  test("treats one typed marker as a hard event without relying on filename or marker count", async () => {
    const content = [
      "Ordinary setup notes about the local cache.\n\n",
      "Decision: Keep the cache on SQLite.\n\n",
      "Ordinary follow-up prose about the same cache.\n",
    ].join("");
    const chunks = await chunkMarkdownSemantically(content, "notes.md", options({
      maxTokens: 100,
      embedBatch: async texts => texts.map(() => [1, 0]),
    }));

    expect(chunks.map(chunk => chunk.text.trim())).toEqual([
      "Ordinary setup notes about the local cache.",
      "Decision: Keep the cache on SQLite.\n\nOrdinary follow-up prose about the same cache.",
    ]);
  });

  test("keeps related explicit events separate even when their vectors are identical", async () => {
    const content = [
      "Decision: Keep SQLite as the local cache.\n\n",
      "Outcome: SQLite now serves the local cache.\n",
    ].join("");
    const chunks = await chunkMarkdownSemantically(content, "notes.md", options({
      maxTokens: 100,
      embedBatch: async texts => texts.map(() => [1, 0]),
    }));

    expect(chunks.map(chunk => chunk.text.trim())).toEqual([
      "Decision: Keep SQLite as the local cache.",
      "Outcome: SQLite now serves the local cache.",
    ]);
  });
});

describe("semantic regions", () => {
  const topicalDocument = [
    "Cats sleep beside warm sunny windows.\n\n",
    "Cats chase toys through quiet rooms.\n\n",
    "Cats purr when their people return.\n\n",
    "Database indexes accelerate repeated query lookups.\n\n",
    "Database pages organize durable stored records.\n\n",
    "Database query planners choose efficient scans.\n",
  ].join("");

  test("merges related atoms and splits at a sharp topical shift", async () => {
    const chunks = await chunkMarkdownSemantically(topicalDocument, "guide.md", options());

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some(chunk => chunk.text.includes("Cats purr"))).toBe(true);
    expect(chunks.some(chunk => chunk.text.includes("Database indexes"))).toBe(true);
    expect(chunks.every(chunk => !(chunk.text.includes("Cats") && chunk.text.includes("Database")))).toBe(true);
  });

  test("merges related ordinary top-level list items", async () => {
    const content = [
      "- Cats sleep beside warm sunny windows.\n",
      "- Cats chase toys through quiet rooms.\n",
      "- Cats purr when their people return.\n",
    ].join("");
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options({ maxTokens: 100 }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
  });

  test("splits a sufficiently sized top-level list at a topical shift", async () => {
    const content = [
      "- Cats sleep beside warm sunny windows every afternoon.\n",
      "- Cats chase toys through quiet rooms after breakfast.\n",
      "- Cats purr softly when their favorite people return.\n",
      "- Database indexes accelerate repeated query lookups for records.\n",
      "- Database pages organize durable stored records for queries.\n",
      "- Database query planners choose efficient index scans automatically.\n",
    ].join("");
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options({ maxTokens: 100 }));

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some(chunk => chunk.text.includes("Cats purr"))).toBe(true);
    expect(chunks.some(chunk => chunk.text.includes("Database indexes"))).toBe(true);
    expect(chunks.every(chunk => !(chunk.text.includes("Cats") && chunk.text.includes("Database")))).toBe(true);
  });

  test("can split at a semantic shift before reaching maxTokens", async () => {
    const content = [
      "Cats sleep beside warm windows each afternoon.\n\n",
      "Cats chase toys through quiet rooms after breakfast.\n\n",
      "Database indexes accelerate repeated query lookups.\n\n",
      "Database pages organize durable stored records.\n",
    ].join("");
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options({
      minTokens: 6,
      maxTokens: 100,
    }));

    expect(await countWords(content)).toBeLessThan(100);
    expect(chunks).toHaveLength(2);
  });

  test("keeps nested and multiline list content attached to its top-level item", async () => {
    const content = [
      "- Cats sleep beside warm windows.\n",
      "  They prefer the sunny cushion.\n",
      "  - Kittens share the same cushion.\n",
      "- Database indexes accelerate repeated queries.\n",
      "  Query planners select the useful index.\n",
      "  - Covering indexes avoid extra reads.\n",
    ].join("");
    const atoms = await scanMarkdownAtoms(content, "guide.md", countWords);

    expect(atoms).toHaveLength(2);
    expect(atoms[0]!.text).toContain("They prefer the sunny cushion.\n  - Kittens share the same cushion.");
    expect(atoms[1]!.text).toContain("Query planners select the useful index.\n  - Covering indexes avoid extra reads.");
  });

  test("documents the two-tiny-atom threshold limitation", async () => {
    const content = "Cats nap.\n\nDatabase indexes.\n";
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options({
      minTokens: 8,
      maxTokens: 100,
    }));

    // One similarity score has no distribution from which to derive a
    // positive threshold, so this minimal case intentionally remains unsplit.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
  });

  test("returns a multi-atom region at or below minTokens without boundary embeddings", async () => {
    const content = "Cats nap.\n\nCats purr.\n";
    let embeddingCalls = 0;
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options({
      minTokens: 4,
      maxTokens: 100,
      embedBatch: async texts => {
        embeddingCalls++;
        return texts.map(topicalVector);
      },
    }));

    expect(chunks).toEqual([{ text: content, pos: 0, tokens: 4 }]);
    expect(embeddingCalls).toBe(0);
  });

  test("embedding transport batch size does not change boundaries", async () => {
    const single = await chunkMarkdownSemantically(topicalDocument, "guide.md", options({ embeddingBatchSize: 1 }));
    const batched = await chunkMarkdownSemantically(topicalDocument, "guide.md", options({ embeddingBatchSize: 100 }));

    expect(single).toEqual(batched);
  });

  test("returns ordered, exact, non-overlapping source spans with zero overlap", async () => {
    const chunks = await chunkMarkdownSemantically(topicalDocument, "guide.md", options());

    expect(chunks.map(chunk => chunk.text).join("")).toBe(topicalDocument);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      expect(topicalDocument.slice(chunk.pos, chunk.pos + chunk.text.length)).toBe(chunk.text);
      expect(chunk.tokens).toBeLessThanOrEqual(20);
      if (index > 0) {
        const previous = chunks[index - 1]!;
        expect(chunk.pos).toBe(previous.pos + previous.text.length);
      }
    }
  });

  test("preserves exact contiguous zero-overlap spans across local list boundaries", async () => {
    const content = [
      "- Cats sleep beside warm windows every afternoon.\n",
      "  Their favorite cushion stays in the sun.\n",
      "- Cats chase toys through quiet rooms after breakfast.\n",
      "- Database indexes accelerate repeated query lookups.\n",
      "  Query planners select an efficient scan.\n",
      "- Database pages organize durable stored records.\n",
    ].join("");
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options({ maxTokens: 100 }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(chunk => chunk.text).join("")).toBe(content);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      expect(content.slice(chunk.pos, chunk.pos + chunk.text.length)).toBe(chunk.text);
      if (index > 0) {
        const previous = chunks[index - 1]!;
        expect(chunk.pos).toBe(previous.pos + previous.text.length);
      }
    }
  });

  test("attaches a heading to following prose rather than embedding a title alone", async () => {
    const content = `# Guide\n\n## Cat behavior\n\n${topicalDocument}`;
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options());

    expect(chunks[0]!.text).toContain("# Guide\n\n## Cat behavior");
    expect(chunks[0]!.text).toContain("Cats sleep");
  });

  test("keeps a fenced block indivisible when it fits the hard limit", async () => {
    const fence = "```ts\nconst database = openIndex();\nrunQuery(database);\n```\n\n";
    const content = `Intro words about cats and windows.\n\n${fence}Closing words about cats and windows.\n`;
    const chunks = await chunkMarkdownSemantically(content, "guide.md", options({ maxTokens: 10, minTokens: 2 }));

    const containingFence = chunks.filter(chunk => chunk.text.includes("```ts"));
    expect(containingFence).toHaveLength(1);
    expect(containingFence[0]!.text).toContain(fence.trimEnd());
    expect(chunks.every(chunk => chunk.tokens <= 10)).toBe(true);
  });

  test("splits an oversized fence only at the hard token ceiling", async () => {
    const content = "```txt\none two three four\nfive six seven eight\nnine ten eleven twelve\n```\n";
    const chunks = await chunkMarkdownSemantically(content, "code.md", options({ maxTokens: 6, minTokens: 2 }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(chunk => chunk.text).join("")).toBe(content);
    expect(chunks.every(chunk => chunk.tokens <= 6)).toBe(true);
    expect(chunks.slice(0, -1).every(chunk => chunk.text.endsWith("\n"))).toBe(true);
  });

  test("bounds tokenizer work when force-splitting a large single atom", async () => {
    const measureWork = async (size: number): Promise<number> => {
      let tokenizedCharacters = 0;
      await chunkMarkdownSemantically("x".repeat(size), "large.md", options({
        minTokens: 25,
        maxTokens: 100,
        countTokens: async text => {
          tokenizedCharacters += text.length;
          return text.length;
        },
        embedBatch: async texts => texts.map(() => [1, 0]),
      }));
      return tokenizedCharacters;
    };

    const smallWork = await measureWork(4_000);
    const largeWork = await measureWork(8_000);

    expect(largeWork).toBeLessThan(smallWork * 2.5);
  });
});
