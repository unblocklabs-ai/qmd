// Compile-only consumer contract: checked by test:types, never executed.
import { createStore, type CollectionConfig, type StoreOptions,
  type VSearchOptions, type VectorSearchResult } from "../src/index.js";

const config: CollectionConfig = {
  global_context: "Project notes",
  collections: { memory: { path: "/tmp/notes", pattern: "**/*.md" } },
};
const options: StoreOptions = { dbPath: "/tmp/index.sqlite", config };
const search: VSearchOptions = { expand: false, collection: "memory", limit: 5 };

async function consumer() {
  const store = await createStore(options);
  const results: VectorSearchResult[] = await store.vsearch("project notes", search);
  await store.close();
  return results;
}
void consumer;
