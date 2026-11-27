import { existsSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openSnapshotDatabase } from "./db.js";

export type SnapshotDocument = {
  id: number;
  collection: string;
  path: string;
  hash: string;
  title: string;
  modifiedAt: string;
};

export interface ReadOnlySnapshot {
  /** All active documents if omitted; none if an empty filter is supplied. */
  listActiveDocuments(collections?: readonly string[]): SnapshotDocument[];
  getDocumentBody(collection: string, path: string): string | null;
  getCollectionGeneration(collection: string): number;
  close(): void;
}

/** Open a committed read view without initializing the store or loading a model. */
export function openReadOnlySnapshot(dbPath: string): ReadOnlySnapshot {
  const path = realpathSync(dbPath);
  const walPath = `${path}-wal`;
  const uri = pathToFileURL(path);
  const walSize = () => statSync(walPath, { throwIfNoEntry: false })?.size ?? 0;
  // A normal read-only SQLite connection still creates WAL sidecars when
  // opening a checkpointed WAL-mode file. Immutable mode bypasses journaling
  // entirely, so use it only when there is no WAL and guard the file version.
  const idle = walSize() === 0;
  const version = () => {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  const initial = idle ? version() : undefined;
  uri.search = idle ? "immutable=1" : "readonly_shm=1";
  const db = openSnapshotDatabase(path, uri, idle);
  const assertUnchanged = () => {
    if (idle && (version() !== initial || walSize() !== 0 || existsSync(`${path}-journal`))) {
      throw new Error("SQLite snapshot source changed; close and reopen the snapshot");
    }
  };
  try {
    assertUnchanged();
    db.exec("PRAGMA query_only = ON; BEGIN");
    const hasGenerations = !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'collection_generations'"
    ).get();
    assertUnchanged();
    const bodyByPath = db.prepare(`
      SELECT c.doc FROM documents d JOIN content c ON c.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `);
    const generation = hasGenerations
      ? db.prepare("SELECT generation FROM collection_generations WHERE collection = ?") : undefined;

    function read<T>(fn: () => T): T {
      assertUnchanged();
      const result = fn();
      assertUnchanged();
      return result;
    }

    return {
      listActiveDocuments: collections => read(() => {
        if (collections?.length === 0) return [];
        // A JSON array uses a single bind even for large sets of collections.
        const filter = collections ? "AND collection IN (SELECT value FROM json_each(?))" : "";
        const rows = db.prepare(`
          SELECT id, collection, path, hash, title, modified_at AS modifiedAt FROM documents
          WHERE active = 1 ${filter} ORDER BY collection, path
        `).all(...(collections ? [JSON.stringify(collections)] : []));
        // The SELECT projects SnapshotDocument's columns from QMD's schema.
        return rows as SnapshotDocument[];
      }),
      getDocumentBody: (collection, docPath) => read(() => {
        // The SELECT projects the non-null TEXT body from QMD's content table.
        const row = bodyByPath.get(collection, docPath) as { doc: string } | undefined;
        return row?.doc ?? null;
      }),
      getCollectionGeneration: collection => read(() => {
        // The SELECT projects the non-null INTEGER generation, when present.
        const row = generation?.get(collection) as { generation: number } | undefined;
        return row?.generation ?? 0;
      }),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
