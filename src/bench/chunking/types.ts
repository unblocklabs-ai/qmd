import { z } from "zod";

export const CHUNKING_ARMS = ["regex", "semantic-v2"] as const;
export type ChunkingArm = typeof CHUNKING_ARMS[number];

export const corpusSchema = z.object({
  id: z.string().min(1),
  collection: z.string().min(1).optional(),
  root: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
});

const sourceSpanFields = {
  file: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  required_anchors: z.array(z.string().min(1)).optional(),
};

const sourceSpanSchema = z.object(sourceSpanFields).refine(span => span.end_line >= span.start_line, {
  message: "end_line must be greater than or equal to start_line",
});

export const queryFixtureSchema = z.object({
  version: z.literal(1),
  corpus: z.string().min(1),
  queries: z.array(z.object({
    id: z.string().min(1),
    query: z.string().min(1),
    category: z.string().min(1).optional(),
    expected: z.array(sourceSpanSchema).min(1),
    hard_negatives: z.array(z.object({
      file: sourceSpanFields.file,
      start_line: sourceSpanFields.start_line,
      end_line: sourceSpanFields.end_line,
    }).refine(span => span.end_line >= span.start_line, {
      message: "end_line must be greater than or equal to start_line",
    })).optional(),
  })).min(1),
});

export type CorpusManifest = z.infer<typeof corpusSchema>;
export type QueryFixture = z.infer<typeof queryFixtureSchema>;
export type EvaluationQuery = QueryFixture["queries"][number];

export type IndexedChunk = {
  arm: ChunkingArm;
  file: string;
  title: string;
  seq: number;
  pos: number;
  length: number;
  startLine: number;
  endLine: number;
  tokens: number;
  text: string;
};

export type RetrievedChunk = {
  rank: number;
  file: string;
  title: string;
  score: number;
  pos: number;
  length: number;
  startLine: number;
  endLine: number;
  tokens: number;
  text: string;
};

export type QueryRetrieval = {
  queryId: string;
  query: string;
  latencyMs: number;
  results: RetrievedChunk[];
};

export type QueryMetrics = {
  fileHitAt1: number;
  fileHitAt3: number;
  fileHitAt5: number;
  spanHitAt1: number;
  spanHitAt3: number;
  spanHitAt5: number;
  spanMrr: number;
  ndcgAt5: number;
  contextPrecisionAt5: number;
  hardNegativeOverlapAt5: number;
  spanRecallAt500Tokens: number;
  spanRecallAt1000Tokens: number;
  spanRecallAt2000Tokens: number;
};

export type ScoredQuery = QueryRetrieval & {
  metrics: QueryMetrics;
  gains: number[];
};

export type ArmEvaluation = {
  arm: ChunkingArm;
  chunkCount: number;
  embeddedTokens: number;
  indexBytes: number;
  ingestDurationMs: number;
  meanQueryLatencyMs: number;
  metrics: QueryMetrics;
  queries: ScoredQuery[];
};

const reviewLabelSchema = z.enum(["A", "B"]);
export type ReviewLabel = z.infer<typeof reviewLabelSchema>;
const rankingSchema = z.array(reviewLabelSchema).length(2).refine(
  ranking => new Set(ranking).size === 2,
  { message: "ranking must contain A and B exactly once" },
);

const dimensionSchema = z.number().int().min(0).max(4).nullable();
export const judgmentSchema = z.object({
  reviewer: z.string().optional(),
  queries: z.array(z.object({
    query_id: z.string().min(1),
    ranking: rankingSchema.nullable(),
    results: z.record(reviewLabelSchema, z.object({
      answer_accuracy: dimensionSchema,
      usefulness: dimensionSchema,
      context_sufficiency: dimensionSchema,
      focus: dimensionSchema,
      notes: z.string(),
    })),
  })),
});

export type Judgments = z.infer<typeof judgmentSchema>;
export type ReviewKey = Record<string, Record<ReviewLabel, ChunkingArm>>;
