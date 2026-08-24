# QMD chunking strategy

**Research cutoff:** 2026-08-23
**Decision:** evolve QMD toward a *small structural hierarchy*: retrieve coherent leaf spans for precision, then expand to adjacent/parent source spans for completeness. Do **not** replace the current splitter with universal semantic chunking, an LLM chunker, or a multi-index router before QMD-specific evidence shows a material gain.

## Executive answer

Chunking is not one parameter with a 2026 “best” value. The best-supported approach is:

1. Preserve document structure and exact source offsets at ingest.
2. Index small, self-contained **leaf** spans with their title and heading path.
3. Keep explicit parent/neighbor relationships so a retrieved leaf can be expanded into coherent evidence at query time.
4. Use the same canonical spans for embedding, reranking, and snippets.
5. Add semantic, multi-granularity, or query-adaptive techniques only as measured extensions.

This fits QMD better than a wholesale research prototype. QMD already has a boundary-aware 900-token embedding chunker with 15% target overlap, optional AST boundaries for several code languages, full-document storage, hybrid retrieval, and reranking. Its material gap is not that it lacks an LLM splitter: embedding and query-time reranking independently re-chunk the document, and neither retains canonical chunk text or a parent-child structure. That loses a clean correspondence among vector hit, rerank input, source span, and final evidence.

## Special case: agent journals and daily memory files

For agent memory, a Markdown file is often a **provenance container**, not one semantic document. A daily file can contain an unrelated deployment observation, user preference, command failure, decision, and follow-up task. Treating the file as one topic and cutting it every N tokens produces blended embeddings: a retrieval hit may resemble several events weakly while precisely representing none of them.

The hierarchy for this corpus must begin *below* the file:

```text
daily file (date and provenance)
  └─ session / conversation / time-delimited event
       └─ observation, decision, task, preference, or outcome
            └─ bounded detail/source span
```

### Agent-journal chunking rules

1. Treat headings and horizontal rules as hard sections. Treat explicit timestamps, session/conversation IDs, and typed labels (`Decision:`, `Task:`, `Outcome:`, `Preference:`) as local hard event boundaries before applying a token target.
2. Treat ordinary top-level bullets, paragraphs, and speaker turns as semantic candidates rather than assuming that every one is a separate event. Embed those atoms and pack related neighbors locally; a dated filename never selects a different algorithm.
3. Use the minimum token size as a soft packing target and the maximum as a hard ceiling. Never merge across an explicit event boundary merely to reach the minimum.
4. Keep date, file path, session ID (when available), label, and enclosing heading as metadata/breadcrumb rather than padding a small chunk with unrelated prose.
5. Accept one lean-MVP limitation explicitly: two tiny, unlabeled atoms may remain merged because a single similarity score provides too little statistical evidence for a reliable split.
6. Retrieve the resulting local span first. Expand only to coherent same-session neighbors or a parent event when the question needs causal context; never expand automatically across the whole day.

This differs from conventional documentation, where a heading/section is usually a valid semantic parent. For journals, *time and interaction boundaries* are first-class structure. A dated file is useful for filtering and citation, but it is not evidence that all contents are related.

### Journal-specific evaluation slice

Include journal queries in Phase 0 that ask for a single decision, exact user preference, prior error/outcome, chronology, and an explanation requiring two facts from the same session. Mark nearby-but-unrelated events in the same daily file as hard negatives. A journal strategy is successful when it raises exact event/source-span recall and avoids contaminating retrieved context with neighboring daily notes.

## What the evidence actually supports

| Approach | What is supported | Why it is not a drop-in default |
| --- | --- | --- |
| **Structure-aware leaves + parent expansion** | ACL 2026 [HiChunk](https://aclanthology.org/2026.acl-long.1372/) finds hierarchical retrieval with Auto-Merge improves evidence-dense retrieval; its sparse-evidence results change much less. | Its hierarchy is built by a fine-tuned LLM and costs material ingestion time. QMD should use headings/AST/blocks first. |
| **Fine-grained propositions** | Peer-reviewed [Dense X Retrieval](https://aclanthology.org/2024.emnlp-main.845/) found self-contained propositions strongest under tight retrieval budgets in Wikipedia QA. | Proposition generation expands the index considerably and can distort source text. It is an optional factoid-retrieval layer, never the only representation. |
| **Late contextual embeddings** | [Late Chunking](https://arxiv.org/abs/2409.04701) reports 1.5–1.9 absolute mean nDCG@10 gains over equivalent naive chunking on its BEIR evaluation, and no clear benefit from overlap. | It needs a long-context embedding model that exposes token-level representations/pooling. QMD’s current embedding path cannot assume that API. |
| **Query-adaptive granularity** | [MoG](https://arxiv.org/abs/2406.00456) routes queries across prebuilt scales; [QASC](https://arxiv.org/abs/2605.22834) expands around query-matched sentences. Both attack the real precision/recall trade-off. | MoG is medical-QA-specific and costs multiple indexes; QASC is a small single-author preprint with internally inconsistent query counts. Neither establishes a universal default. |
| **Hierarchical summaries** | [RAPTOR](https://arxiv.org/abs/2401.18059) supports multiple abstraction levels for long, multi-step questions. | Summaries are lossy and can fabricate/omit facts. Use them for routing/discovery, not citations or grounded answer evidence. |
| **Generated contextual prefixes** | Anthropic’s [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) shows a practical way to add document/section identity to an otherwise ambiguous chunk. | This is vendor-reported evidence with per-chunk generation cost; validate locally before adoption. |

**Interpretation:** semantic segmentation is useful only when it produces more coherent evidence under the same retrieval-token and latency budget. It is not automatically better than good structural boundaries. A reliable baseline must therefore beat the current boundary-safe algorithm *on QMD queries*, not merely match a paper’s aggregate answer score.

## Recommended target model

```text
document (original content, immutable source offsets)
  └─ section / heading path
       └─ subsection (when present)
            └─ leaf (paragraph, list group, table, or code declaration/block)

query → retrieve leaf vectors + FTS → fuse/rerank canonical leaves
      → expand selected leaves to neighbors or parent under token budget
      → return source-backed snippets/context
```

### Canonical records

Each indexed leaf needs only:

- `document_id`, `start`, `end`, and ordinal position;
- `parent_id` and a heading-path/title breadcrumb;
- block kind (`prose`, `list`, `table`, `code`, or `other`);
- raw source text (or recoverable range) and model/version fingerprints.

The source range remains authoritative. Do not embed generated summaries as if they were source text, and do not re-create boundaries independently in embedding, reranking, and snippets.

### Leaf rules

Use natural blocks first, with a **soft target of roughly 150–400 tokens** for prose and a hard model-limit guardrail. That range is an initial experiment value, not a literature-derived constant. It is deliberately smaller than QMD’s current 900-token embedding target to increase evidence density; parent expansion restores context when needed.

- Never split inside a table, fenced code block, or AST declaration unless it exceeds the model limit.
- Preserve Markdown heading paths and code symbol/file context in the embedding text; retain raw source separately.
- Merge very short adjacent prose/list blocks until they are useful retrieval units.
- Split oversize blocks at the strongest internal structural boundary; only then fall back to sentence/newline/token cuts.
- For code, use AST declaration spans where available; retain imports/module path as metadata or prefix, not as repeated raw overlap.

Do **not** make overlap the default context mechanism. It duplicates vectors and creates near-identical candidates. Keep it as an evaluated fallback for formats where a needed evidence span repeatedly crosses valid leaf boundaries; [Late Chunking](https://arxiv.org/abs/2409.04701) found no consistent overlap benefit in its controlled ablation.

### Query-time expansion

Retrieve/rerank leaves first. Then assemble the returned context with deterministic rules:

| Query/evidence signal | Context returned |
| --- | --- |
| One high-confidence fact leaf | leaf, with heading breadcrumb |
| Explanation/procedure | leaf plus immediate previous/next leaf if the final token budget allows |
| Multiple sibling leaf hits | replace/augment with their parent span when it is more compact than separate leaves |
| Broad, comparative, or multi-hop question | retrieve relevant sections (or later, summary nodes), then select the supporting raw leaves |

Expansion must be measured in **tokens**, deduplicated by source range, and stopped at the final context budget. This is the low-risk version of HiChunk Auto-Merge and QASC contextual-window expansion: it does not require a query-time corpus re-chunk or LLM-generated boundaries.

## Delivery plan

The concrete, bounded engineering plan is in [Lean semantic chunking implementation for QMD](semantic_chunking_implementation.md). It ports only the statistical similarity algorithm, adds deterministic journal/Markdown atoms, and carries exact vector spans into reranking; it deliberately defers hierarchy, chunk-level FTS, and query-time semantic re-chunking.

### Phase 0 — establish the decision dataset (first)

Before changing defaults, collect 200–500 representative QMD queries. Stratify them by exact lookup, local explanation, procedure, comparison, multi-hop, document type (Markdown/prose/code/tables/lists), document length, and known boundary-crossing cases. Annotate acceptable **source ranges**, not merely a relevant document.

Score each arm with the same embedding model, FTS/hybrid settings, candidate count, reranker, and final retrieved-token budget:

- source-span Recall@5/10/20 and nDCG/MRR;
- context precision/coherence and source-range coverage;
- answer correctness, citation/span entailment, faithfulness, and completeness;
- chunk count, index bytes, ingest time/cost, and p50/p95 query/rerank latency.

Use a paired comparison on the same queries (with confidence intervals or randomization/bootstrap), inspect failures by stratum, and reserve a small held-out set only after choosing a design. [RAGBench](https://arxiv.org/abs/2407.11005) is useful here: retrieval relevance, utilization, grounded adherence, and answer completeness are distinct outcomes.

### Phase 1 — canonical structural spans (recommended implementation)

1. Parse Markdown blocks/headings and existing AST code declarations into a canonical span table.
2. Parse local session/event markers and typed fact labels before generic block grouping in every Markdown file; use the filename only as provenance, not as a journal-profile switch.
3. Store parent and adjacent-leaf relationships alongside current content/vector metadata.
4. Embed and rerank those exact spans; add title + heading/symbol breadcrumb to the embedding input.
5. Replace query-time independent re-chunking with retrieval of the canonical span and deterministic context expansion.
6. Compare this structural-child-plus-parent baseline to the current 900-token/15%-overlap baseline, including a journal-specific slice.

**Adoption bar:** require a practically meaningful improvement in source-span recall and grounded answer completeness for affected query classes, without an unacceptable p95 latency or index-size increase. If it does not clear that bar, retain the current implementation and its existing boundary improvements.

### Phase 2 — only for observed failure modes

| Observed problem | Narrow experiment |
| --- | --- |
| Pronouns/implicit subjects or cross-paragraph context reduce vector recall | Evaluate late chunking if QMD’s embedding stack can expose long-context token embeddings; otherwise test a short, clearly labeled contextual prefix. |
| Fact/entity lookup misses dense evidence | Test proposition leaves for that collection only, always linked to a raw parent source span. |
| Broad/multi-hop questions miss document-scale context | Index section summaries for *routing only*, then ground answers in linked raw leaves. |
| Different query types favor incompatible contexts | Route among the prebuilt leaf/subsection/section levels. Start with transparent heuristics; consider a learned MoG-style router only after enough labeled queries exist. |
| Hit leaf is right but evidence crosses its boundary | Test neighbor/parent expansion first; introduce limited overlap only if that specific slice improves. |

Do not start with an LLM semantic splitter, five duplicated granularities, arbitrary clustering, or query-time semantic re-chunking. Those are material complexity and ingestion/serving costs without QMD-specific proof.

## Assessment of the papers named in the request

- **MoG:** valuable confirmation that granularity can be query-dependent; its best QMD translation is routing among a *small set of prebuilt structural levels*, not dynamically generating chunks.
- **Enhancing RAG with Hierarchical Text Segmentation Chunking:** the accessible 2025 arXiv work of that title/topic supports segment-plus-cluster representations on long-document QA. The Springer chapter with the supplied title was located, but its full paper was not reliably available in this research pass, so it is not used for numerical claims.
- **HiChunk:** strongest new direct evidence because it is an ACL 2026 paper and its benchmark makes chunking differences visible. Adopt its *retrieve-small, merge-to-parent* principle—not its fine-tuned LLM hierarchy—first.
- **QASC:** a good design sketch for query-conditioned expansion, but not a production default. Its paper is a small, single-author arXiv preprint and reports conflicting query counts (200 in abstract; 40 in body/results).

## Research limits and stopping rule

This report prioritizes original research and official publication pages through 2026-08-23. Numerical improvements are author-reported, not independently reproduced. Results are not directly comparable across different corpora, retrievers, models, or final-context budgets. The additional targeted literature stopped once peer-reviewed work (Dense X, HiChunk) plus the relevant new preprints and implementation evidence converged on the same low-complexity architecture; further papers were unlikely to identify a universal chunk size or negate the need for a QMD-local evaluation.

## Source list

1. Chen et al. (2024), [Dense X Retrieval: What Retrieval Granularity Should We Use?](https://aclanthology.org/2024.emnlp-main.845/), EMNLP 2024.
2. Lu et al. (2026), [HiChunk: Evaluating and Enhancing Retrieval Augmented Generation with Hierarchical Chunking](https://aclanthology.org/2026.acl-long.1372/), ACL 2026.
3. Günther et al. (2024/2025), [Late Chunking: Contextual Chunk Embeddings Using Long-Context Embedding Models](https://arxiv.org/abs/2409.04701).
4. Zhong et al. (2025), [Mix-of-Granularity: Optimize the Chunking Granularity for Retrieval-Augmented Generation](https://arxiv.org/abs/2406.00456), COLING 2025.
5. Rastogi (2026), [Query-Adaptive Semantic Chunking for Retrieval-Augmented Generation](https://arxiv.org/abs/2605.22834).
6. Sarthi et al. (2024), [RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval](https://arxiv.org/abs/2401.18059), ICLR 2024.
7. Nguyen et al. (2025), [Enhancing Retrieval Augmented Generation with Hierarchical Text Segmentation Chunking](https://arxiv.org/abs/2507.09935).
8. Friel et al. (2024/2025), [RAGBench](https://arxiv.org/abs/2407.11005).
9. Anthropic (2024), [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) — first-party, non-peer-reviewed implementation report.
