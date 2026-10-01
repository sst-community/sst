// A component the way an app writes one: in a file of its own, with nothing
// imported. `sst` and `aws` are globals, as they are in `sst.config.ts`.
declare const aws: typeof import("@pulumi/aws");

const parts = {
  bucket: aws.s3.Bucket,
  audit: sst.optional(aws.s3.Bucket),
  reader: sst.many(aws.iam.Role),
};

interface UploadsArgs extends sst.ComponentArgs<typeof parts> {
  teams: string[];
  audit?: boolean;
}

export class Uploads extends sst.component("acme:Uploads", parts) {
  constructor(
    name: string,
    args: UploadsArgs,
    opts?: $util.ComponentResourceOptions,
  ) {
    super(name, args, opts);

    this.part("bucket", { forceDestroy: true });
    if (args.audit) this.part("audit", {});
    for (const team of args.teams)
      this.part("reader", team, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: "lambda.amazonaws.com",
        }),
      });
  }

  get name() {
    return this.nodes.bucket.bucket;
  }

  link() {
    return {
      properties: { name: this.name },
      include: [
        sst.aws.permission({
          actions: ["s3:GetObject"],
          resources: [$interpolate`${this.nodes.bucket.arn}/*`],
        }),
      ],
    };
  }
}

// The same component after its bucket's key changed to `files`: once with
// nothing to keep the bucket, and once declared with the name it had.
const renamed = { files: aws.s3.Bucket };
export class Renamed extends sst.component("acme:Uploads", renamed) {
  constructor(name: string) {
    super(name, {});
    this.part("files", { forceDestroy: true });
  }
}

const kept = { files: sst.named(aws.s3.Bucket, "Bucket") };
export class Kept extends sst.component("acme:Uploads", kept) {
  constructor(name: string) {
    super(name, {});
    this.part("files", { forceDestroy: true });
  }
}
