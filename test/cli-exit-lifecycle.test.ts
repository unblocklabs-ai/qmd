import { describe, expect, test } from "vitest";
import { finishSuccessfulCliCommand } from "../src/cli/qmd.ts";
import { LlamaCpp, isDarwinMetalMitigationActive } from "../src/llm.ts";

describe("CLI successful-exit lifecycle", () => {
  test("exits 0 after successful output when post-output LLM cleanup fails", async () => {
    const stderr: string[] = [];
    const flushed: string[] = [];
    const prevCode = process.exitCode;
    process.exitCode = 1;
    try {
      await finishSuccessfulCliCommand({
        command: "query",
        format: "json",
        cleanup: async () => {
          throw new Error("ggml_metal_device_free abort simulation");
        },
        stdout: { write: (chunk: string | Uint8Array, cb?: (error?: Error | null) => void) => { flushed.push(String(chunk)); cb?.(); return true; } },
        stderr: { write: (chunk: string | Uint8Array, cb?: (error?: Error | null) => void) => { stderr.push(String(chunk)); cb?.(); return true; } },
      });

      expect(process.exitCode).toBe(0);
      expect(stderr.join("")).toContain("QMD Warning: cleanup after successful output failed");
      expect(flushed).toEqual([""]);
    } finally {
      process.exitCode = prevCode;
    }
  });

  test("production path: sets process.exitCode=0 and returns instead of calling process.exit", async () => {
    // Natural shutdown sets process.exitCode and returns, letting Node's `beforeExit` fire so
    // node-llama-cpp's auto-dispose runs BEFORE libc's static destructor.
    // process.exit() skips `beforeExit`, which is what trips the libggml-metal
    // assertion (ggml-org/llama.cpp#22593) even with explicit dispose.
    const prevCode = process.exitCode;
    process.exitCode = 1; // poison the state to verify we set it
    try {
      const calls: string[] = [];
      await finishSuccessfulCliCommand({
        command: "query",
        format: "json",
        cleanup: async () => { calls.push("cleanup"); },
        stdout: { write: (_c: string | Uint8Array, cb?: (error?: Error | null) => void) => { calls.push("stdout-flush"); cb?.(); return true; } },
        stderr: { write: (_c: string | Uint8Array, cb?: (error?: Error | null) => void) => { calls.push("stderr-flush"); cb?.(); return true; } },
      });

      expect(calls).toEqual(["stdout-flush", "cleanup", "stderr-flush"]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = prevCode;
    }
  });

  test("darwin Metal mitigation reflects launcher-exported env on darwin", () => {
    // The real mitigation lives in bin/qmd, which sets GGML_METAL_NO_RESIDENCY=1
    // before Node loads the llama.cpp native binding. The JS-side predicate
    // just reports whether that env was set (and not overridden by
    // QMD_METAL_KEEP_RESIDENCY). On non-darwin the function returns false.
    const expected =
      process.platform === "darwin" &&
      process.env.QMD_METAL_KEEP_RESIDENCY !== "1" &&
      process.env.GGML_METAL_NO_RESIDENCY === "1";
    expect(isDarwinMetalMitigationActive()).toBe(expected);
  });

  test("QMD_METAL_KEEP_RESIDENCY=1 disables the mitigation even when GGML_METAL_NO_RESIDENCY is set", () => {
    const prevKeep = process.env.QMD_METAL_KEEP_RESIDENCY;
    const prevNoRes = process.env.GGML_METAL_NO_RESIDENCY;
    try {
      process.env.QMD_METAL_KEEP_RESIDENCY = "1";
      process.env.GGML_METAL_NO_RESIDENCY = "1";
      expect(isDarwinMetalMitigationActive()).toBe(false);
    } finally {
      if (prevKeep === undefined) delete process.env.QMD_METAL_KEEP_RESIDENCY;
      else process.env.QMD_METAL_KEEP_RESIDENCY = prevKeep;
      if (prevNoRes === undefined) delete process.env.GGML_METAL_NO_RESIDENCY;
      else process.env.GGML_METAL_NO_RESIDENCY = prevNoRes;
    }
  });

  test("disposes Llama resources in dependency order before CLI exit", async () => {
    const calls: string[] = [];
    const llm = new LlamaCpp({ inactivityTimeoutMs: 0 });
    const disposable = (name: string) => ({
      dispose: async () => {
        calls.push(name);
      },
    });

    Object.assign(llm, {
      embedContexts: [disposable("embed-context")],
      rerankContexts: [disposable("rerank-context")],
      embedModel: disposable("embed-model"),
      generateModel: disposable("generate-model"),
      rerankModel: disposable("rerank-model"),
      llama: disposable("llama"),
    });

    await llm.dispose();

    expect(calls).toEqual([
      "embed-context",
      "rerank-context",
      "embed-model",
      "generate-model",
      "rerank-model",
      "llama",
    ]);
  });
});
