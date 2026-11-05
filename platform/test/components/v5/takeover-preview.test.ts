import { describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";
const pulumi = mockPulumi({
  preview: true,
  state: (r) =>
    r.type === "aws:dynamodb/table:Table"
      ? { arn: UNKNOWN, name: UNKNOWN, streamArn: UNKNOWN }
      : { arn: UNKNOWN },
});

// In a new stage's preview, a resource about to be created has no ARN yet,
// and the old address of a subscriber that a takeover map gives is made from
// it. Pulumi fails on an alias it can't resolve, so `sst diff` of a new stage
// failed, and so did a deploy that previews first.
describe("a subscriber in a new stage's preview", () => {
  it("is planned, though its old address isn't known yet", async () => {
    // The group, as an app has it, with the takeover maps
    const { Queue, Bucket, Dynamo, SnsTopic } = await import(
      "../../../src/components/aws/index"
    );
    new Queue("Jobs").subscribe("src/subscriber.handler");
    new SnsTopic("Events").subscribe("Logger", "src/subscriber.handler");
    new Bucket("Files").notify({
      notifications: [{ name: "Uploads", function: "src/subscriber.handler" }],
    });
    new Dynamo("Items", {
      fields: { pk: "string" },
      primaryIndex: { hashKey: "pk" },
      stream: "new-image",
    }).subscribe("Changes", "src/subscriber.handler");
    await pulumi.settle();

    const names = pulumi.resources.map((r) => r.name);
    expect(names).toContain("JobsSubscriber");
    expect(names).toContain("JobsEventSourceMapping");
    expect(names).toContain("FilesSubscriberUploads");
    expect(names).toContain("ItemsSubscriberChanges");
    expect(names).toContain("EventsSubscriberLogger");
    expect(names).toContain("EventsSubscriptionLogger");
  });
});
