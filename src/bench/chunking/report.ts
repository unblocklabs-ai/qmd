import type { ArmEvaluation, ChunkingArm } from "./types.js";
import { CHUNKING_ARMS } from "./types.js";
import type { JudgmentSummary } from "./review.js";

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const ms = (value: number): string => value.toFixed(1);
const mib = (value: number): string => (value / (1024 * 1024)).toFixed(2);

export function buildObjectiveReport(evaluations: readonly ArmEvaluation[]): string {
  const byArm = new Map(evaluations.map(evaluation => [evaluation.arm, evaluation]));
  const rows = CHUNKING_ARMS.map(arm => {
    const evaluation = byArm.get(arm);
    if (!evaluation) throw new Error(`Missing evaluation arm ${arm}`);
    const metric = evaluation.metrics;
    return `| ${arm} | ${evaluation.chunkCount} | ${evaluation.embeddedTokens} | ${mib(evaluation.indexBytes)} | ${ms(evaluation.ingestDurationMs)} | ${pct(metric.fileHitAt1)} | ${pct(metric.spanHitAt1)} | ${pct(metric.spanHitAt5)} | ${metric.spanMrr.toFixed(3)} | ${metric.ndcgAt5.toFixed(3)} | ${pct(metric.contextPrecisionAt5)} | ${pct(metric.hardNegativeOverlapAt5)} | ${pct(metric.spanRecallAt1000Tokens)} | ${ms(evaluation.meanQueryLatencyMs)} |`;
  });
  return [
    "# Chunking evaluation",
    "",
    "Automated metrics identify retrieval and span failures. They do not replace the blinded usefulness review in `review.md`.",
    "",
    "| Arm | Chunks | Embedded tokens | Index MiB | Ingest ms | File@1 | Span@1 | Span@5 | Span MRR | nDCG@5 | Context precision@5 | Hard-negative overlap@5 | Span recall@1000t | Warm query ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    "## Interpretation",
    "",
    "- Prefer span hits and usefulness judgments over file hits, especially for daily journals containing unrelated facts.",
    "- Higher context precision and focus are better; lower hard-negative overlap is better.",
    "- Token-budget recall compares how much useful evidence each strategy retrieves for the same downstream context budget.",
    "- BM25 is intentionally omitted: document-level FTS content is identical across these indexes and is only an integrity check.",
    "",
  ].join("\n");
}

export function buildJudgmentReport(summary: JudgmentSummary): string {
  const row = (arm: ChunkingArm): string => {
    const value = summary[arm];
    return `| ${arm} | ${value.reviews} | ${value.average.answer_accuracy.toFixed(2)} | ${value.average.usefulness.toFixed(2)} | ${value.average.context_sufficiency.toFixed(2)} | ${value.average.focus.toFixed(2)} | ${value.averageOverall.toFixed(2)} | ${value.firstPlace} |`;
  };
  return [
    "# Blinded judgment summary",
    "",
    "| Arm | Reviewed queries | Accuracy | Usefulness | Sufficiency | Focus | Overall | First-place rankings |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...CHUNKING_ARMS.map(row),
    "",
  ].join("\n");
}
