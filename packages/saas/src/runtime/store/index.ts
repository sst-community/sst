import type { StoreConfig } from "../../config";
import { dynamoStore } from "./dynamo";
import type { Page, PageArgs, Store } from "./types";

export * from "./types";
export { dynamoStore, type DynamoStoreArgs } from "./dynamo";
export { memoryStore } from "./memory";

/** Every page of a list, one after another. */
export async function collect<T>(
  list: (page: PageArgs) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

/** The store the component set up. */
export function createStore(config: StoreConfig): Store {
  switch (config.type) {
    case "dynamo":
      return dynamoStore({ tables: config.tables });
    case "custom":
      throw new Error(
        `The component's "storage" is "custom", so it has no store of its own. Pass yours to createHandlers({ store }), route(handler, { store }) or createMailer({ store }).`,
      );
  }
}
