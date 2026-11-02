import { describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";
import { EVERY_PART, everyPart } from "./bucket-every-part";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

// A new stage's preview: everything is about to be created, so of each
// resource only what it was given is known, and nothing AWS gives back
const pulumi = mockPulumi({
  preview: true,
  state: (args) =>
    Object.fromEntries(
      ["arn", "bucket", "name", "invokeArn", "qualifiedArn", "version", "url"]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    ),
});

describe("a bucket in a new stage's preview", () => {
  it("plans everything a deploy creates", async () => {
    await everyPart();
    await pulumi.settle();
    expect(pulumi.resources.map((r) => r.name).sort()).toEqual(EVERY_PART);
  });
});
