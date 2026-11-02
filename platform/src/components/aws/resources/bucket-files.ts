import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

/** A file to upload, and how it's served. */
export interface BucketFile {
  /** Where the file is on this machine. */
  source: string;
  /** Its key in the bucket. */
  key: string;
  cacheControl?: string;
  contentType: string;
  /** A hash of what's in it, so it's uploaded again when that changes. */
  hash?: string;
}

export interface BucketFilesArgs {
  bucketName: Input<string>;
  files: Input<BucketFile[]>;
  /** Whether files in the bucket that aren't in `files` are deleted. */
  purge: Input<boolean>;
  region: Input<string>;
}

/**
 * Files uploaded to a bucket: uploaded again when they change, and deleted
 * when they're gone from the list. One of SST's own resources, which the
 * `sst` binary serves as a Pulumi provider.
 */
export class BucketFiles extends CustomResource {
  constructor(
    name: string,
    args: BucketFilesArgs,
    opts?: CustomResourceOptions,
  ) {
    super("sst:aws:BucketFiles", name, { ...args }, opts);
  }
}
