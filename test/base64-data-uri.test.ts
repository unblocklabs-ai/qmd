import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  normalizeContentForIndex,
  reindexCollection,
} from "../src/store.js";

describe("base64 data URI ingestion sanitization", () => {
  test("omits large standalone Markdown reference payloads and inline images", () => {
    const payload = "A".repeat(20_000);
    expect(
      normalizeContentForIndex(
        `[diagram]: data:image/png;base64,${payload}\n\n![diagram](data:image/svg+xml;base64,QUJDRA==)`,
        "report.md",
      ),
    ).toBe(
      "[diagram]: data:image/png;base64,[omitted]\n\n![diagram](data:image/svg+xml;base64,[omitted])",
    );
  });

  test("never consumes following lines", () => {
    const source =
      "[diagram]: data:image/png;base64,QUJD\nBody text\n\n[other]: /safe/reference.png\n";
    expect(normalizeContentForIndex(source, "report.md")).toBe(
      "[diagram]: data:image/png;base64,[omitted]\nBody text\n\n[other]: /safe/reference.png\n",
    );
  });

  test("handles case-insensitive markers, parameters, fragments, and percent-encoded bytes", () => {
    const source =
      "<DATA:application/octet-stream;charset=utf-8;BASE64,QUJD%2BRA%3D%3D#preview>";
    expect(normalizeContentForIndex(source, "report.markdown")).toBe(
      "<DATA:application/octet-stream;charset=utf-8;BASE64,[omitted]#preview>",
    );
  });

  test("keeps URI positions correct after Unicode with length-changing lowercase forms", () => {
    expect(normalizeContentForIndex(
      "İ(data:image/png;base64,QUJDRA==)",
      "report.md",
    )).toBe("İ(data:image/png;base64,[omitted])");
  });

  test("preserves the slash in an HTML self-closing data URI", () => {
    expect(normalizeContentForIndex(
      "<img src=data:image/png;base64,QUJDRA==/><p>after</p>",
      "report.md",
    )).toBe("<img src=data:image/png;base64,[omitted]/><p>after</p>");

    expect(normalizeContentForIndex(
      "<data:application/octet-stream;base64,////>",
      "report.md",
    )).toBe("<data:application/octet-stream;base64,[omitted]>");
  });

  test("leaves non-base64 data and ordinary URLs unchanged", () => {
    const source =
      "data:image/png,hello\nhttps://example.com/image.png\nhttps://example.com/data:image/png;base64,QUJDRA==\ndata:image/png;base64,hello!\n";
    expect(normalizeContentForIndex(source, "report.md")).toBe(source);
  });

  test("does not rewrite source-code collections", () => {
    const source = 'const fixture = "data:image/png;base64,QUJDRA==";\n';
    expect(normalizeContentForIndex(source, "fixture.ts")).toBe(source);
  });

  test("leaves identifiers, malformed near-misses, and repeated malformed prefixes unchanged", () => {
    const repeatedPrefix = "data:".repeat(4_000);
    const source = [
      "metadata:image/png;base64,QUJDRA==",
      "data:image/png;base64,QUJD%2GRA==",
      "data:image/png;base64,QUJD!RA==",
      repeatedPrefix,
    ].join("\n");
    expect(normalizeContentForIndex(source, "report.md")).toBe(source);
  });

  test("stores one sanitized hash when only the image payload changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-base64-uri-"));
    const dbPath = join(root, "index.sqlite");
    const filePath = join(root, "notes.md");
    const store = createStore(dbPath);
    try {
      const prefix = "# Stable title\n\n[diagram]: data:image/png;base64,";
      await writeFile(filePath, `${prefix}AAAA\n`);
      expect((await reindexCollection(store, root, "**/*.md", "docs")).indexed).toBe(1);

      const first = store.db
        .prepare(
          "SELECT d.hash, c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = ? AND d.active = 1",
        )
        .get("docs") as { hash: string; body: string };
      expect(first.body).toBe(`${prefix}[omitted]\n`);

      await writeFile(filePath, `${prefix}BBBB\n`);
      const secondResult = await reindexCollection(store, root, "**/*.md", "docs");
      expect(secondResult.unchanged).toBe(1);
      const second = store.db
        .prepare("SELECT hash FROM documents WHERE collection = ? AND active = 1")
        .get("docs") as { hash: string };
      expect(second.hash).toBe(first.hash);
      expect(await readFile(filePath, "utf8")).toContain("BBBB");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
