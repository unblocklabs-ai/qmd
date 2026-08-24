import { createHash } from "node:crypto";
import type {
  ArmEvaluation,
  ChunkingArm,
  IndexedChunk,
  Judgments,
  ReviewKey,
  ReviewLabel,
} from "./types.js";
import { CHUNKING_ARMS, judgmentSchema } from "./types.js";

const LABELS: readonly ReviewLabel[] = ["A", "B"];
const DIMENSIONS = ["answer_accuracy", "usefulness", "context_sufficiency", "focus"] as const;

function shuffledArms(seed: string, itemId: string): ChunkingArm[] {
  return [...CHUNKING_ARMS].sort((left, right) => {
    const hash = (arm: ChunkingArm) => createHash("sha256").update(`${seed}:${itemId}:${arm}`).digest("hex");
    return hash(left).localeCompare(hash(right));
  });
}

function mappingFor(seed: string, itemId: string): Record<ReviewLabel, ChunkingArm> {
  const arms = shuffledArms(seed, itemId);
  return { A: arms[0]!, B: arms[1]! };
}

function markdownBlock(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text.trimEnd()}\n${fence}`;
}

export function buildReviewArtifacts(
  evaluations: readonly ArmEvaluation[],
  seed: string,
  resultsPerArm = 3,
): { markdown: string; key: ReviewKey; judgments: Judgments } {
  const byArm = new Map(evaluations.map(evaluation => [evaluation.arm, evaluation]));
  const first = evaluations[0];
  if (!first) throw new Error("At least one arm evaluation is required");

  const key: ReviewKey = {};
  const judgments: Judgments = { queries: [] };
  const lines = [
    "# Blinded chunking retrieval review",
    "",
    "Rate each result set on a 0-4 scale. Judge whether the shown context supports an accurate, useful answer—not whether its vector score is high.",
    "",
    "- **Answer accuracy:** the context supports the correct answer without encouraging a false one.",
    "- **Usefulness:** the context directly advances answering the query.",
    "- **Context sufficiency:** enough surrounding detail is present to use the fact correctly.",
    "- **Focus:** the context avoids unrelated or distracting material.",
    "",
  ];

  for (const query of first.queries) {
    const map = mappingFor(seed, query.queryId);
    key[query.queryId] = map;
    judgments.queries.push({
      query_id: query.queryId,
      ranking: null,
      results: {
        A: { answer_accuracy: null, usefulness: null, context_sufficiency: null, focus: null, notes: "" },
        B: { answer_accuracy: null, usefulness: null, context_sufficiency: null, focus: null, notes: "" },
      },
    });
    lines.push(`## ${query.queryId}`, "", `> ${query.query}`, "");
    for (const label of LABELS) {
      const arm = map[label];
      const armQuery = byArm.get(arm)?.queries.find(candidate => candidate.queryId === query.queryId);
      lines.push(`### Set ${label}`, "");
      if (!armQuery || armQuery.results.length === 0) {
        lines.push("_No results._", "");
        continue;
      }
      for (const result of armQuery.results.slice(0, resultsPerArm)) {
        lines.push(
          `**#${result.rank} — ${result.file}:${result.startLine}-${result.endLine}** (score ${result.score.toFixed(4)}, ${result.tokens} tokens)`,
          "",
          markdownBlock(result.text),
          "",
        );
      }
    }
  }

  return { markdown: lines.join("\n"), key, judgments };
}

export function buildChunkReviewArtifacts(
  chunks: ReadonlyMap<ChunkingArm, readonly IndexedChunk[]>,
  seed: string,
  maxFiles = 3,
): { markdown: string; key: ReviewKey } {
  const files = [...new Set([...chunks.values()].flatMap(items => items.map(item => item.file)))].sort().slice(0, maxFiles);
  const key: ReviewKey = {};
  const lines = [
    "# Blinded chunk-boundary review",
    "",
    "This is a small boundary sample. Look for split facts, mixed topics, missing structural context, and chunks that are too small to be useful.",
    "",
  ];
  for (const file of files) {
    const map = mappingFor(seed, `chunks:${file}`);
    key[file] = map;
    lines.push(`## ${file}`, "");
    for (const label of LABELS) {
      const arm = map[label];
      const armChunks = chunks.get(arm)?.filter(chunk => chunk.file === file) ?? [];
      lines.push(`### Set ${label} (${armChunks.length} chunks)`, "");
      for (const chunk of armChunks) {
        lines.push(
          `**Chunk ${chunk.seq + 1}: lines ${chunk.startLine}-${chunk.endLine}, ${chunk.tokens} tokens**`,
          "",
          markdownBlock(chunk.text),
          "",
        );
      }
    }
  }
  return { markdown: lines.join("\n"), key };
}

export type JudgmentSummary = Record<ChunkingArm, {
  reviews: number;
  average: Record<typeof DIMENSIONS[number], number>;
  averageOverall: number;
  firstPlace: number;
}>;

export function summarizeJudgments(input: unknown, key: ReviewKey): JudgmentSummary {
  const judgments = judgmentSchema.parse(input);
  const totals = Object.fromEntries(CHUNKING_ARMS.map(arm => [arm, {
    reviews: 0,
    dimensionTotals: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, 0])) as Record<typeof DIMENSIONS[number], number>,
    dimensionCounts: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, 0])) as Record<typeof DIMENSIONS[number], number>,
    firstPlace: 0,
  }])) as Record<ChunkingArm, {
    reviews: number;
    dimensionTotals: Record<typeof DIMENSIONS[number], number>;
    dimensionCounts: Record<typeof DIMENSIONS[number], number>;
    firstPlace: number;
  }>;

  for (const query of judgments.queries) {
    const map = key[query.query_id];
    if (!map) throw new Error(`Review key has no query ${query.query_id}`);
    if (query.ranking) totals[map[query.ranking[0]!]].firstPlace++;
    for (const label of LABELS) {
      const arm = map[label];
      const rating = query.results[label];
      if (DIMENSIONS.some(dimension => rating[dimension] !== null)) totals[arm].reviews++;
      for (const dimension of DIMENSIONS) {
        const value = rating[dimension];
        if (value === null) continue;
        totals[arm].dimensionTotals[dimension] += value;
        totals[arm].dimensionCounts[dimension]++;
      }
    }
  }

  return Object.fromEntries(CHUNKING_ARMS.map(arm => {
    const total = totals[arm];
    const average = Object.fromEntries(DIMENSIONS.map(dimension => [
      dimension,
      total.dimensionCounts[dimension] === 0 ? 0 : total.dimensionTotals[dimension] / total.dimensionCounts[dimension],
    ])) as Record<typeof DIMENSIONS[number], number>;
    return [arm, {
      reviews: total.reviews,
      average,
      averageOverall: DIMENSIONS.reduce((sum, dimension) => sum + average[dimension], 0) / DIMENSIONS.length,
      firstPlace: total.firstPlace,
    }];
  })) as JudgmentSummary;
}
