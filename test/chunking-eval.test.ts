import { describe, expect, test } from "vitest";
import { buildReviewArtifacts, summarizeJudgments } from "../src/bench/chunking/review.js";
import { lineRangeToOffsets, scoreQuery } from "../src/bench/chunking/score.js";
import type { ArmEvaluation, EvaluationQuery, QueryRetrieval } from "../src/bench/chunking/types.js";
import { getEmbeddingFingerprint, type ChunkStrategy } from "../src/store.js";

const body = [
  "# Daily notes",
  "",
  "Decision: Keep SQLite for the local cache.",
  "The cache remains on disk between runs.",
  "",
  "Unrelated deployment notes live here.",
].join("\n");

const query: EvaluationQuery = {
  id: "cache",
  query: "Which cache did we choose?",
  expected: [{ file: "day.md", start_line: 3, end_line: 4, required_anchors: ["SQLite"] }],
  hard_negatives: [{ file: "day.md", start_line: 6, end_line: 6 }],
};

describe("chunking evaluation scoring", () => {
  test("turns line ranges into exact source offsets", () => {
    const offsets = lineRangeToOffsets(body, 3, 4);
    expect(body.slice(offsets.start, offsets.end)).toContain("SQLite");
    expect(body.slice(offsets.start, offsets.end)).not.toContain("deployment");
  });

  test("rewards the useful event span and penalizes a nearby hard negative", () => {
    const expected = lineRangeToOffsets(body, 3, 4);
    const negative = lineRangeToOffsets(body, 6, 6);
    const retrieval: QueryRetrieval = {
      queryId: query.id,
      query: query.query,
      latencyMs: 10,
      results: [
        {
          rank: 1,
          file: "day.md",
          title: "Daily notes",
          score: 0.9,
          pos: expected.start,
          length: expected.end - expected.start,
          startLine: 3,
          endLine: 4,
          tokens: 20,
          text: body.slice(expected.start, expected.end),
        },
        {
          rank: 2,
          file: "day.md",
          title: "Daily notes",
          score: 0.8,
          pos: negative.start,
          length: negative.end - negative.start,
          startLine: 6,
          endLine: 6,
          tokens: 10,
          text: body.slice(negative.start, negative.end),
        },
      ],
    };
    const scored = scoreQuery(query, retrieval, new Map([["day.md", body]]));

    expect(scored.gains).toEqual([3, 1]);
    expect(scored.metrics.spanHitAt1).toBe(1);
    expect(scored.metrics.spanMrr).toBe(1);
    expect(scored.metrics.hardNegativeOverlapAt5).toBe(0.5);
  });

  test("keeps evaluator fingerprints distinct", () => {
    const strategies = ["regex", "semantic"] satisfies ChunkStrategy[];
    const fingerprints = strategies.map(strategy => getEmbeddingFingerprint(undefined, strategy));
    expect(new Set(fingerprints).size).toBe(2);
  });
});

describe("blinded review artifacts", () => {
  test("use one judgment schema for blinded human or agent review and unblind it", () => {
    const evaluation = (arm: ArmEvaluation["arm"]): ArmEvaluation => ({
      arm,
      chunkCount: 1,
      embeddedTokens: 20,
      indexBytes: 100,
      ingestDurationMs: 5,
      meanQueryLatencyMs: 10,
      metrics: {
        fileHitAt1: 1, fileHitAt3: 1, fileHitAt5: 1,
        spanHitAt1: 1, spanHitAt3: 1, spanHitAt5: 1,
        spanMrr: 1, ndcgAt5: 1, contextPrecisionAt5: 1, hardNegativeOverlapAt5: 0,
        spanRecallAt500Tokens: 1, spanRecallAt1000Tokens: 1, spanRecallAt2000Tokens: 1,
      },
      queries: [{
        queryId: "cache",
        query: "Which cache?",
        latencyMs: 10,
        gains: [3],
        metrics: {
          fileHitAt1: 1, fileHitAt3: 1, fileHitAt5: 1,
          spanHitAt1: 1, spanHitAt3: 1, spanHitAt5: 1,
          spanMrr: 1, ndcgAt5: 1, contextPrecisionAt5: 1, hardNegativeOverlapAt5: 0,
          spanRecallAt500Tokens: 1, spanRecallAt1000Tokens: 1, spanRecallAt2000Tokens: 1,
        },
        results: [{
          rank: 1, file: "day.md", title: "Day", score: 0.9, pos: 0, length: 5,
          startLine: 1, endLine: 1, tokens: 2, text: "fact",
        }],
      }],
    });
    const artifacts = buildReviewArtifacts([
      evaluation("regex"), evaluation("semantic-v2"),
    ], "seed");
    const filled = structuredClone(artifacts.judgments);
    filled.queries[0]!.ranking = ["A", "B"];
    for (const [index, label] of filled.queries[0]!.ranking.entries()) {
      filled.queries[0]!.results[label] = {
        answer_accuracy: 4 - index,
        usefulness: 4 - index,
        context_sufficiency: 4 - index,
        focus: 4 - index,
        notes: "",
      };
    }
    const summary = summarizeJudgments(filled, artifacts.key);
    const winner = artifacts.key.cache!.A;

    expect(artifacts.markdown).toContain("Set A");
    expect(summary[winner].averageOverall).toBe(4);
    expect(summary[winner].firstPlace).toBe(1);
  });
});
