import { interpolate } from "@pulumi/pulumi";
import { takeover } from "../../takeover";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { Bucket } from "../v5/bucket";
import { childOf } from "./helpers";

// The 4.x `Bucket` keeps what `notify()` creates in a component of its own,
// named after the bucket. It's created with the bucket's own options, so it's
// next to the bucket wherever the bucket is. The V5 one keeps it inside the
// bucket, with each notification's resources under the notification's name.
//
// A bucket referenced with the 4.x `Bucket.get` isn't given the options `get`
// is given, so its notifications are at the top of the app whatever those say.
const NOTIFICATION = "sst:aws:BucketNotification";
const notified = (bucket: Bucket, name: string, child: string) => [
  childOf(NOTIFICATION, `${name}Notifications`, child, bucket),
  childOf(NOTIFICATION, `${name}Notifications`, child),
];

// The deprecated `subscribe()`, `subscribeQueue()` and `subscribeTopic()`
// keep theirs in a subscriber component at the top of the app, named after
// the bucket's ARN. A bucket has at most one, and never next to a `notify()`.
const FUNCTION = "sst:aws:BucketLambdaSubscriber";
const SUBSCRIBERS = [
  FUNCTION,
  "sst:aws:BucketQueueSubscriber",
  "sst:aws:BucketTopicSubscriber",
];
const subscriber = (bucket: Bucket, name: string) =>
  bucket.nodes.bucket.arn.apply(
    (arn) => `${name}Subscriber${logicalName(hashStringToPrettyString(arn, 6))}`,
  );
// The policy of a subscribed queue or topic was created outside of the
// subscriber component, with no parent.
const subscriberPolicy = (bucket: Bucket, name: string) => ({
  name: interpolate`${subscriber(bucket, name)}Policy`,
  parent: false as const,
});
// The one subscriber becomes one notification: the first of its kind. Two
// resources can't both be what it was.
const first = (created: Record<string, unknown>) =>
  Object.keys(created).length === 0;

takeover(Bucket, {
  moved: {
    notification: (bucket, { name }) => [
      ...notified(bucket, name, "Notification"),
      ...SUBSCRIBERS.map((type) =>
        childOf(type, subscriber(bucket, name), "Notification"),
      ),
    ],
    subscriber: (bucket, { name, id }) => [
      ...notified(bucket, name, `Notification${id}`),
      ...(first(bucket.nodes.subscriber)
        ? [childOf(FUNCTION, subscriber(bucket, name), "Function")]
        : []),
    ],
    permission: (bucket, { name, id }) => [
      ...notified(bucket, name, `Notification${id}Permission`),
      ...(first(bucket.nodes.permission)
        ? [childOf(FUNCTION, subscriber(bucket, name), "Permission")]
        : []),
    ],
    queuePolicy: (bucket, { name, id }) => [
      ...notified(bucket, name, `Notification${id}Policy`),
      ...(first(bucket.nodes.queuePolicy)
        ? [subscriberPolicy(bucket, name)]
        : []),
    ],
    topicPolicy: (bucket, { name, id }) => [
      ...notified(bucket, name, `Notification${id}Policy`),
      ...(first(bucket.nodes.topicPolicy)
        ? [subscriberPolicy(bucket, name)]
        : []),
    ],
  },
});
