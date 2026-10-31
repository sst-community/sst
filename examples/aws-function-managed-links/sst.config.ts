/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "aws-function-managed-links",
      home: "aws",
      removal: "remove",
    };
  },
  async run() {
    const bucket = new sst.aws.Bucket("Files");
    // Large, distinct grants to paths in the bucket demonstrate the inline-size limit.
    const groups = ["One", "Two", "Three"].map(
      (name) =>
        new sst.Linkable(name, {
          properties: { bucket: bucket.name },
          include: [
            sst.aws.permission({
              actions: ["s3:GetObject"],
              resources: Array.from(
                { length: 36 },
                (_, i) =>
                  $interpolate`${
                    bucket.arn
                  }/group-${name}/object-${i}/${"x".repeat(30)}`,
              ),
            }),
          ],
        }),
    );
    const fn = new sst.aws.Function("Reader", {
      handler: "index.handler",
      link: [bucket, ...groups],
      linkPermissions: {
        managed: {
          Storage: [bucket, groups[0]],
          Two: [groups[1]],
          Three: [groups[2]],
        },
      },
      url: true,
    });
    // A smaller function can demonstrate migration and rollback within the inline limit.
    const phase = process.env.PERMISSIONS_PHASE ?? "managed";
    if (!["inline", "both", "managed"].includes(phase))
      throw new Error("PERMISSIONS_PHASE must be inline, both, or managed");
    const migration = new sst.aws.Function("Migration", {
      handler: "index.migration",
      link: [bucket, groups[0]],
      linkPermissions:
        phase === "inline"
          ? undefined
          : {
              managed: { Storage: [bucket, groups[0]] },
              retainInline: phase === "both",
            },
      url: true,
    });
    return {
      bucket: bucket.name,
      url: fn.url,
      function: fn.name,
      role: fn.nodes.role.name,
      migrationUrl: migration.url,
      migrationRole: migration.nodes.role.name,
    };
  },
});
