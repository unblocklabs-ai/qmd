#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildJudgmentReport } from "../src/bench/chunking/report.js";
import { summarizeJudgments } from "../src/bench/chunking/review.js";
import { runChunkingEvaluation } from "../src/bench/chunking/run.js";
import type { ReviewKey } from "../src/bench/chunking/types.js";

function usage(): never {
  console.error(`Usage:
  pnpm eval:chunking run --corpus <manifest.json> --queries <queries.json> [--out <dir>] [--limit 10]
  pnpm eval:chunking review --run <run-dir>
  pnpm eval:chunking summarize --run <run-dir> [--judgments <judgments.json>]`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  options: {
    corpus: { type: "string" },
    queries: { type: "string" },
    out: { type: "string" },
    run: { type: "string" },
    judgments: { type: "string" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) usage();
const command = positionals[0];

if (command === "run") {
  if (!values.corpus || !values.queries) usage();
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  const runDir = await runChunkingEvaluation({
    corpusPath: values.corpus,
    queriesPath: values.queries,
    outputDir: values.out,
    limit,
  });
  console.log(runDir);
} else if (command === "review") {
  if (!values.run) usage();
  const runDir = resolve(values.run);
  for (const file of ["chunk-review.md", "review.md", join("reviews", "judgments.json")]) {
    const path = join(runDir, file);
    if (!existsSync(path)) throw new Error(`Missing review artifact: ${path}`);
    console.log(path);
  }
} else if (command === "summarize") {
  if (!values.run) usage();
  const runDir = resolve(values.run);
  const judgmentPath = resolve(values.judgments ?? join(runDir, "reviews", "judgments.json"));
  const keyPath = join(runDir, "reviews", "review-key.json");
  const judgments: unknown = JSON.parse(readFileSync(judgmentPath, "utf8"));
  const key = JSON.parse(readFileSync(keyPath, "utf8")) as ReviewKey;
  const summary = summarizeJudgments(judgments, key);
  const outputPath = join(runDir, "judgment-report.md");
  writeFileSync(outputPath, buildJudgmentReport(summary));
  writeFileSync(join(runDir, "judgment-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(outputPath);
} else {
  usage();
}
