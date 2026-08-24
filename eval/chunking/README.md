# Chunking evaluator

This evaluator compares the exact indexed chunks and controlled vector-search results for:

- `regex`: original QMD chunking (~900 tokens, 15% overlap)
- `semantic-v2`: structural + semantic chunking (`semantic` in normal QMD commands)

It is deliberately separate from `qmd bench`: the existing benchmark grades files, while this evaluator grades the retrieved source span and the usefulness of the returned context.

## 1. Define a corpus

Only explicitly listed files are indexed. Relative `root` paths resolve from the manifest.

```json
{
  "id": "my-corpus",
  "collection": "chunk-eval",
  "root": "/absolute/path/to/corpus",
  "files": ["guide.md", "2026-08-23.md"]
}
```

## 2. Define ground-truth queries

Expected evidence is line-addressed, so a correct daily file with the wrong event chunk does not count as a span hit. `required_anchors` distinguish a merely overlapping chunk from one containing the essential fact. Hard negatives identify plausible but misleading nearby passages.

```json
{
  "version": 1,
  "corpus": "my-corpus",
  "queries": [
    {
      "id": "cache-decision",
      "query": "Which cache did we choose?",
      "category": "decision",
      "expected": [
        {
          "file": "2026-08-23.md",
          "start_line": 12,
          "end_line": 14,
          "required_anchors": ["SQLite"]
        }
      ],
      "hard_negatives": [
        { "file": "2026-08-23.md", "start_line": 30, "end_line": 34 }
      ]
    }
  ]
}
```

Do not commit fixtures containing private journal facts. Put private manifests and queries under `.qmd-evals/`.

## 3. Run both arms

```sh
pnpm eval:chunking run --corpus eval/chunking/corpora/my-corpus.json --queries eval/chunking/queries/my-corpus.json
```

Each run creates a fresh ignored directory under `.qmd-evals/runs/` containing:

- isolated SQLite indexes
- exact stored chunks as JSONL
- exact no-expansion `vsearch` results
- automated span metrics and an objective report
- `chunk-review.md` for a small blinded boundary review
- `review.md` for blinded query-result review
- `reviews/judgments.json`, shared by human and future agent reviewers
- separate review keys so reviewers need not know which strategy produced A/B

Use `--out <new-directory>` to choose a run path. Existing directories are never overwritten.

## 4. Review actual usefulness

```sh
pnpm eval:chunking review --run .qmd-evals/runs/<run-id>
```

Open the printed Markdown files. For every query, rank A/B and score each result set from 0 to 4 for:

1. answer accuracy
2. usefulness toward the query
3. context sufficiency
4. focus / lack of unrelated noise

Edit `reviews/judgments.json`. A later Codex or API reviewer should receive the same blinded Markdown and fill the same JSON schema; no separate agent-only scoring path is needed.

## 5. Unblind and summarize

```sh
pnpm eval:chunking summarize --run .qmd-evals/runs/<run-id>
```

This writes `judgment-report.md` and `judgment-summary.json`. Automated metrics and human/agent judgments remain separate rather than being collapsed into a misleading single score.
