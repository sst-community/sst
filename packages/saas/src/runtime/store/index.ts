import type { StoreConfig } from "../../config";
import { dynamoStore } from "./dynamo";
import type { Store } from "./types";

export * from "./types";
export { dynamoStore, type DynamoStoreArgs } from "./dynamo";
export { memoryStore } from "./memory";

/** The store the component set up. */
export function createStore(config: StoreConfig): Store {
  switch (config.type) {
    case "dynamo":
      return dynamoStore({ tables: config.tables });
    case "custom":
      throw new Error(
        `The component's "storage" is "custom", so it has no store of its own. Pass yours to createHandlers({ store }) or route(handler, { store }).`,
      );
  }
}
