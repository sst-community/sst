// A bucket with a part of every kind: run as a deploy in `bucket.test.ts`, and
// as a new stage's preview in `bucket-preview.test.ts`. Both create what
// `EVERY_PART` lists, so `sst diff` and `sst migrate --check` see everything a
// deploy creates.
export async function everyPart() {
  const { Bucket } = await import("../../../src/components/aws/v5/bucket");
  const { Function } = await import("../../../src/components/aws/v5/function");
  const { Queue } = await import("../../../src/components/aws/v5/queue");
  const { SnsTopic } = await import(
    "../../../src/components/aws/v5/sns-topic"
  );
  await import("../../../src/components/aws/takeover/index");

  const other = new Function("Other", { handler: "src/other.handler" });
  const bucket = new Bucket("Files", {
    versioning: true,
    lifecycle: [{ prefix: "tmp/", expiresIn: "3 days" }],
  });
  bucket
    .notify({
      eventBridge: true,
      notifications: [
        // A subscriber that links its own bucket
        {
          name: "Resizer",
          function: { handler: "src/resize.handler", link: [bucket] },
        },
        { name: "Auditor", function: other.arn },
        { name: "Other", function: other },
        { name: "Jobs", queue: new Queue("Jobs") },
        { name: "Events", topic: new SnsTopic("Events") },
      ],
    })
    .subscribeEventBridge("Tagger", "src/tag.handler")
    .subscribeEventBridge("Archiver", other.arn);
}

export const EVERY_PART = [
  "Events",
  "EventsTopic",
  "Files",
  "FilesBucket",
  "FilesCors",
  "FilesEventBridgePermissionArchiver",
  "FilesEventBridgePermissionTagger",
  "FilesEventBridgeRuleArchiver",
  "FilesEventBridgeRuleTagger",
  "FilesEventBridgeSubscriberTagger",
  "FilesEventBridgeSubscriberTaggerCode",
  "FilesEventBridgeSubscriberTaggerFunction",
  "FilesEventBridgeSubscriberTaggerLogGroup",
  "FilesEventBridgeSubscriberTaggerRole",
  "FilesEventBridgeTargetArchiver",
  "FilesEventBridgeTargetTagger",
  "FilesLifecycle",
  "FilesNotification",
  "FilesPermissionAuditor",
  "FilesPermissionOther",
  "FilesPermissionResizer",
  "FilesPolicy",
  "FilesPublicAccessBlock",
  "FilesQueuePolicyJobs",
  "FilesSubscriberResizer",
  "FilesSubscriberResizerCode",
  "FilesSubscriberResizerFunction",
  "FilesSubscriberResizerLogGroup",
  "FilesSubscriberResizerRole",
  "FilesTopicPolicyEvents",
  "FilesVersioning",
  "Jobs",
  "JobsQueue",
  "LambdaEncryptionKey",
  "Other",
  "OtherCode",
  "OtherFunction",
  "OtherLogGroup",
  "OtherRole",
];
