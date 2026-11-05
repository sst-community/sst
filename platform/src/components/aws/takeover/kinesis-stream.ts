import { takeover } from "../../takeover";
import { logicalName } from "../../naming";
import { KinesisStream } from "../kinesis-stream";
import { childOf, subscriberFunction } from "./helpers";

// The 4.x `KinesisStream` keeps each subscription in a component of its own,
// at the top of the app, as the 4.x `Dynamo` does. SST 5's keeps them
// inside the stream. The component was named after the stream and the
// subscriber: after the stream's component for one added with
// `stream.subscribe()`, and after the stream's own name for one added with the
// static `KinesisStream.subscribe()`, which only has a stream ARN.
//
// A subscriber that was added without a name isn't carried over: its name was
// made from the stream's ARN, the filters and the handler.
const SUBSCRIBER = "sst:aws:KinesisStreamLambdaSubscriber";
const subscribers = (stream: KinesisStream, name: string, id?: string) => [
  `${name}Subscriber${id}`,
  stream.name.apply(
    (streamName) => `${logicalName(streamName)}Subscriber${id}`,
  ),
];

takeover(KinesisStream, {
  moved: {
    subscriber: (stream, { name, id }) =>
      subscribers(stream, name, id).flatMap((subscriber) =>
        subscriberFunction(SUBSCRIBER, subscriber),
      ),
    eventSourceMapping: (stream, { name, id }) =>
      subscribers(stream, name, id).map((subscriber) =>
        childOf(SUBSCRIBER, subscriber, "EventSourceMapping"),
      ),
  },
});
