# GRPO (Experimental)

This folder contains the **experimental** GRPO training path for query expansion.
It is not part of the default production pipeline.

## Files

- `grpo.py` – standalone GRPO training script with its own configuration

## Run

```bash
# Run from finetune/
uv run experiments/grpo/grpo.py
```

## Notes

- Current mainline focuses on SFT-only quality and benchmarks.
- Keep this workflow isolated unless you are explicitly experimenting with
  reinforcement-learning refinement.
