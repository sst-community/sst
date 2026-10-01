import { takeover } from "../../takeover";
import { logicalName } from "../../naming";
import { DynamoV5 } from "../dynamo-v5";
import { childOf } from "./helpers";

// `Dynamo` keeps each subscription in a component of its own, at the top of
// the app. `DynamoV5` keeps them inside the table. The component was named
// after the table and the subscriber: after the table's component for one
// added with `table.subscribe()`, and after the table's own name for one
// added with the static `Dynamo.subscribe()`, which only has a stream ARN.
//
// A subscriber that was added without a name isn't carried over: its name was
// made from the filters and the handler.
const SUBSCRIBER = "sst:aws:DynamoLambdaSubscriber";
const subscribers = (table: DynamoV5, name: string, id?: string) => [
  `${name}Subscriber${id}`,
  table.name.apply((tableName) => `${logicalName(tableName)}Subscriber${id}`),
];

takeover(DynamoV5, {
  from: "sst:aws:Dynamo",
  moved: {
    subscriber: (table, { name, id }) =>
      subscribers(table, name, id).map((subscriber) =>
        childOf(SUBSCRIBER, subscriber, "Function"),
      ),
    eventSourceMapping: (table, { name, id }) =>
      subscribers(table, name, id).map((subscriber) =>
        childOf(SUBSCRIBER, subscriber, "EventSourceMapping"),
      ),
  },
});
