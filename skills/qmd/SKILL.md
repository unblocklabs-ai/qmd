---
name: qmd
description: Read indexed local markdown, inspect QMD collections, and maintain QMD indexes when requested. Ranked agent search uses OpenClaw memory_search instead of the removed QMD query/search commands.
license: MIT
compatibility: Requires qmd CLI or MCP server; ranked agent search requires the Unblock Memory OpenClaw plugin.
metadata:
  author: tobi
  version: "2.2.0"
allowed-tools: memory_search, memory_get, Bash(qmd:*), mcp__qmd__*
---

# QMD indexed reads and maintenance

## Search through Unblock Memory

When OpenClaw's `memory_search` is available, supply both retrieval queries:

```json
{ "bm25Query": "rollout approval Bek", "vectorQuery": "Who approved the rollout and under what conditions?" }
```

The keyword query finds names/identifiers; the semantic query defines what
information is needed. BM25 and vector candidates share independent TypeSafe
usefulness ranking. Scope with the tool's `corpora` and `sessionFilter`;
these are not QMD collection IDs or audience access controls.

The QMD CLI `query`, `search` and `deep-search` alias, MCP `query`,
and REST `/query` and `/search` are removed. Do not attempt those routes.
If the memory plugin is unavailable, `qmd vsearch "question" --no-expand`
remains available for local vector-only diagnostics; it is not the ranked pipeline.

## Read and verify evidence

Search snippets are leads, not proof. With plugin results use `memory_get`
and follow `nextFrom` when present. For standalone QMD results:

```bash
qmd get qmd://notes/example.md:120:40
qmd get "#abc123:120:40"
qmd multi-get "#abc123,#def432" --format md
```

Reads are line-numbered by default. Preserve source attribution and dates.
Use QMD's line-range suffix or read flags, not shell text slicing. `--full-path`
returns an on-disk path when resolvable; the indexed snapshot may be stale.

## Index inspection and maintenance

`qmd collection list`, `qmd ls`, `qmd status` and `qmd doctor`
inspect indexed scope/health. Only run collection changes, `qmd update`,
`qmd embed` or model downloads when the user requests setup/maintenance.
Do not maintain a live plugin-managed index as a casual retrieval fallback.

For read-only MCP setup, see [references/mcp-setup.md](references/mcp-setup.md).
