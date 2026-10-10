/**
 * `--full-path` fallback tests.
 *
 * `--full-path` swaps the `qmd://` URI + docid for the file's on-disk path.
 * When a result can't be resolved on disk — the file moved or was deleted
 * since the last index — it falls back to the URI. That fallback must:
 *   1. keep the docid, so the row is still addressable (search/query used to
 *      drop it, unlike get/multi-get), and
 *   2. say so on stderr, so the stale index is visible rather than silent.
 *
 * stdout must stay machine-clean in every format.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rename, rm, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function runQmd(
  args: string[],
  opts: { cwd: string; dbPath: string; configDir: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runner = isBunRuntime
    ? { command: process.execPath, args: [qmdScript, ...args] }
    : { command: process.execPath, args: [tsxCli, qmdScript, ...args] };

  const proc = spawn(runner.command, runner.args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      INDEX_PATH: opts.dbPath,
      QMD_CONFIG_DIR: opts.configDir,
      PWD: opts.cwd,
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((res, rej) => {
    proc.once("error", rej);
    proc.on("close", (code) => res(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

// The runtime prints unrelated Node deprecation notices on some versions;
// assert on our own warning rather than on stderr being empty.
const hasFullPathWarning = (stderr: string) =>
  /--full-path could not resolve/.test(stderr);

let testDir: string;
let collectionDir: string;
let dbPath: string;
let configDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-full-path-"));
  const envDir = join(testDir, "env");
  collectionDir = join(envDir, "corpus");
  dbPath = join(envDir, "test.sqlite");
  configDir = join(envDir, "config");

  await mkdir(collectionDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  await writeFile(join(collectionDir, "alpha.md"), "# Alpha\n\nsearchterm-stale alpha\n");
  await writeFile(join(collectionDir, "beta.md"), "# Beta\n\nsearchterm-stale beta\n");
  collectionDir = realpathSync(collectionDir);

  const add = await runQmd(
    ["collection", "add", collectionDir, "--name", "stale"],
    { cwd: collectionDir, dbPath, configDir }
  );
  expect(add.exitCode, `collection add failed: ${add.stderr}`).toBe(0);

  // beta.md moves out of the collection: its row is now stale.
  await rename(join(collectionDir, "beta.md"), join(testDir, "beta-moved.md"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("--full-path fallback for unresolvable results", () => {



  test("get warns and falls back to qmd:// + docid", async () => {
    const { stdout, stderr, exitCode } = await runQmd(
      ["get", "beta.md", "--full-path"],
      { cwd: collectionDir, dbPath, configDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout.split("\n")[0]).toMatch(/^qmd:\/\/stale\/beta\.md {2}#[a-f0-9]{6}$/);
    expect(hasFullPathWarning(stderr)).toBe(true);
  });

  test("multi-get warns when a requested file is gone from disk", async () => {
    const { stdout, stderr, exitCode } = await runQmd(
      ["multi-get", "alpha.md,beta.md", "--full-path", "--format", "files"],
      { cwd: collectionDir, dbPath, configDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/#[a-f0-9]{6},qmd:\/\/stale\/beta\.md/);
    expect(hasFullPathWarning(stderr)).toBe(true);
  });


});
