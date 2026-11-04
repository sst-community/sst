// What a site with a server works out from its build: the files it uploads, what it
// keeps in the key-value store its CloudFront function reads, and when to clear
// CloudFront's cache. The 4.x sites and the V5 ones deploy the same, so it lives
// here, in one place.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { globSync } from "glob";
import type { BucketFile } from "./providers/bucket-files";
import { type BaseSiteFileOptions, getContentType } from "../base/base-site";
import { toPosix } from "../path";
import { hashFiles } from "./helpers/file-hashes";
import { type Duration, toSeconds } from "../duration";
import type { KV_SITE_METADATA, ProtectionConfig } from "./router-code";

// CloudFront KeyValueStore keys are at most 512 bytes, including the
// `<namespace>:` prefix.
const MAX_KV_KEY_LENGTH = 500;
// The KV store holds 5 MB and is shared by the sites on a Router, so each site
// lists at most 1 MB of prerendered files.
const MAX_LISTED_KV_BYTES = 1024 * 1024;

// Regions without Lambda function URLs, which the server functions use. Creating one there
// fails with `AccessDeniedException: Unable to determine service/operation name to be
// authorized`. Checked by creating a function URL in each region, in October 2026. The ones
// not listed here either work or couldn't be reached (me-south-1, Bahrain, is out of
// service). AWS no longer publishes a list of these regions; the page below is the general
// function URL documentation:
// https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html
export const regionsWithoutFunctionUrls = [
  "ap-east-2",
  "ap-south-2",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-west-1",
  "eu-central-2",
  "il-central-1",
  "me-central-1",
  "mx-central-1",
];

export const supportedRegions = {
  "af-south-1": { lat: -33.9249, lon: 18.4241 }, // Cape Town, South Africa
  "ap-east-1": { lat: 22.3193, lon: 114.1694 }, // Hong Kong
  "ap-east-2": { lat: 25.033, lon: 121.5654 }, // Taipei, Taiwan
  "ap-northeast-1": { lat: 35.6895, lon: 139.6917 }, // Tokyo, Japan
  "ap-northeast-2": { lat: 37.5665, lon: 126.978 }, // Seoul, South Korea
  "ap-northeast-3": { lat: 34.6937, lon: 135.5023 }, // Osaka, Japan
  "ap-southeast-1": { lat: 1.3521, lon: 103.8198 }, // Singapore
  "ap-southeast-2": { lat: -33.8688, lon: 151.2093 }, // Sydney, Australia
  "ap-southeast-3": { lat: -6.2088, lon: 106.8456 }, // Jakarta, Indonesia
  "ap-southeast-4": { lat: -37.8136, lon: 144.9631 }, // Melbourne, Australia
  "ap-southeast-5": { lat: 3.139, lon: 101.6869 }, // Kuala Lumpur, Malaysia
  "ap-southeast-6": { lat: -36.8485, lon: 174.7633 }, // Auckland, New Zealand
  "ap-southeast-7": { lat: 13.7563, lon: 100.5018 }, // Bangkok, Thailand
  "ap-south-1": { lat: 19.076, lon: 72.8777 }, // Mumbai, India
  "ap-south-2": { lat: 17.385, lon: 78.4867 }, // Hyderabad, India
  "ca-central-1": { lat: 45.5017, lon: -73.5673 }, // Montreal, Canada
  "ca-west-1": { lat: 51.0447, lon: -114.0719 }, // Calgary, Canada
  "cn-north-1": { lat: 39.9042, lon: 116.4074 }, // Beijing, China
  "cn-northwest-1": { lat: 38.4872, lon: 106.2309 }, // Yinchuan, Ningxia
  "eu-central-1": { lat: 50.1109, lon: 8.6821 }, // Frankfurt, Germany
  "eu-central-2": { lat: 47.3769, lon: 8.5417 }, // Zurich, Switzerland
  "eu-north-1": { lat: 59.3293, lon: 18.0686 }, // Stockholm, Sweden
  "eu-south-1": { lat: 45.4642, lon: 9.19 }, // Milan, Italy
  "eu-south-2": { lat: 40.4168, lon: -3.7038 }, // Madrid, Spain
  "eu-west-1": { lat: 53.3498, lon: -6.2603 }, // Dublin, Ireland
  "eu-west-2": { lat: 51.5074, lon: -0.1278 }, // London, UK
  "eu-west-3": { lat: 48.8566, lon: 2.3522 }, // Paris, France
  "il-central-1": { lat: 32.0853, lon: 34.7818 }, // Tel Aviv, Israel
  "me-central-1": { lat: 25.2048, lon: 55.2708 }, // Dubai, UAE
  "me-south-1": { lat: 26.0667, lon: 50.5577 }, // Manama, Bahrain
  "mx-central-1": { lat: 19.4326, lon: -99.1332 }, // Mexico City, Mexico
  "sa-east-1": { lat: -23.5505, lon: -46.6333 }, // São Paulo, Brazil
  "us-east-1": { lat: 39.0438, lon: -77.4874 }, // Ashburn, VA
  "us-east-2": { lat: 39.9612, lon: -82.9988 }, // Columbus, OH
  "us-gov-east-1": { lat: 38.9696, lon: -77.3861 }, // Herndon, VA
  "us-gov-west-1": { lat: 34.0522, lon: -118.2437 }, // Los Angeles, CA
  "us-west-1": { lat: 37.7749, lon: -122.4194 }, // San Francisco, CA
  "us-west-2": { lat: 45.5122, lon: -122.6587 }, // Portland, OR
};

/**
 * Where a site's build put what it serves: its assets, with what's cached and
 * versioned, its ISR cache, and the paths that go to its image optimizer.
 * The 4.x sites' `Plan` is one.
 */
export type SitePlan = {
  // The base path of the site (ie. /docs). Note that S3 assets are not stored inside a
  // folder with this name. The CF router will stripe the base path from the request URI
  // when routing to S3.
  base?: string;
  imageOptimizer?: {
    prefix: string;
  };
  assets: {
    from: string;
    // KV asset entries do not include the `to` value in their keys. The CF router will
    // add the `to` value to the request URI when routing to S3.
    to: string;
    cached: boolean;
    versionedSubDir?: string;
    deepRoute?: string;
    // List every file in this copy in the KV store instead of routing its
    // folders to S3. For copies that hold prerendered routes only.
    listFiles?: boolean;
  }[];
  isrCache?: {
    from: string;
    to: string;
  };
  custom404?: string;
  buildId?: string;
  // Asset folders with an `.html` file at any depth are listed file by file
  // in the KV store instead of being routed to S3 as a whole, so server
  // routes in the same folder still reach the server.
  hasStaticRoutes?: boolean;
  // Top-level asset folders known to hold prerendered routes. They're listed
  // file by file too.
  prerenderedDirs?: string[];
};

/** How a site's assets are uploaded: the `assets` arg of a site. */
export interface SiteAssets {
  textEncoding?: "utf-8" | "iso-8859-1" | "windows-1252" | "ascii" | "none";
  versionedFilesCacheHeader?: string;
  nonVersionedFilesCacheHeader?: string;
  fileOptions?: BaseSiteFileOptions[];
  purge?: boolean;
}

/**
 * The files a site uploads to its bucket, with their headers: its assets and
 * its ISR cache.
 *
 * @param pathPrefix The path the site is routed under, `/docs`, when it's
 * served through a router.
 * @param textEncoding The charset of text files. The 4.x sites always used
 * `UTF-8`.
 */
export async function siteFiles(input: {
  plan: Pick<SitePlan, "assets" | "isrCache">;
  outputPath: string;
  assets?: SiteAssets;
  pathPrefix?: string;
  textEncoding: string;
}): Promise<BucketFile[]> {
  const { plan, outputPath, assets, pathPrefix } = input;
  // Define content headers
  const versionedFilesTTL = 31536000; // 1 year
  const nonVersionedFilesTTL = 86400; // 1 day

  const bucketFiles: BucketFile[] = [];

  // Handle each copy source
  for (const copy of [
    ...plan.assets,
    ...(plan.isrCache
      ? [{ ...plan.isrCache, versionedSubDir: undefined }]
      : []),
  ]) {
    // Build fileOptions
    const fileOptions: BaseSiteFileOptions[] = [
      // unversioned files
      {
        files: "**",
        ignore: copy.versionedSubDir
          ? toPosix(path.join(copy.versionedSubDir, "**"))
          : undefined,
        cacheControl:
          assets?.nonVersionedFilesCacheHeader ??
          `public,max-age=0,s-maxage=${nonVersionedFilesTTL},stale-while-revalidate=${nonVersionedFilesTTL}`,
      },
      // versioned files
      ...(copy.versionedSubDir
        ? [
            {
              files: toPosix(path.join(copy.versionedSubDir, "**")),
              cacheControl:
                assets?.versionedFilesCacheHeader ??
                `public,max-age=${versionedFilesTTL},immutable`,
            },
          ]
        : []),
      ...(assets?.fileOptions ?? []),
    ];

    // Upload files based on fileOptions
    const filesUploaded = new Set<string>();
    for (const fileOption of fileOptions.reverse()) {
      const files = globSync(fileOption.files, {
        cwd: path.resolve(outputPath, copy.from),
        nodir: true,
        dot: true,
        ignore: fileOption.ignore,
      }).filter((file) => !filesUploaded.has(file));

      const sources = files.map((file) =>
        path.resolve(outputPath, copy.from, file),
      );
      const hashes = await hashFiles(sources);
      bucketFiles.push(
        ...files.map((file, i) => ({
          source: sources[i],
          key: toPosix(
            path.join(copy.to, pathPrefix?.replace(/^\//, "") ?? "", file),
          ),
          hash: hashes[i],
          cacheControl: fileOption.cacheControl,
          contentType:
            fileOption.contentType ?? getContentType(file, input.textEncoding),
        })),
      );
      for (const file of files) filesUploaded.add(file);
    }
  }
  return bucketFiles;
}

/**
 * What a site keeps in the key-value store its CloudFront function reads: the
 * paths that go to S3, and its metadata.
 *
 * @param name The site's name, for the warning when it has too many
 * prerendered files to list.
 * @param pathPrefix The path the site is routed under, when it's served
 * through a router.
 * @param timeout How long the server may take, which is how long CloudFront
 * waits for it.
 */
export function siteKvEntries(input: {
  name: string;
  plan: SitePlan;
  outputPath: string;
  bucketDomain: string;
  timeout: Duration;
  protection: ProtectionConfig;
  pathPrefix?: string;
  servers: { region: string; url?: string }[];
  imageOptimizerUrl?: string;
}) {
  const {
    name,
    plan,
    outputPath,
    bucketDomain,
    timeout,
    pathPrefix,
    servers,
    imageOptimizerUrl,
  } = input;
  const protectionConfig = input.protection;
  const kvEntries: Record<string, string> = {};
  const dirs: string[] = [];
  // Router append .html and index.html suffixes to requests to s3 routes:
  // - `.well-known` contain files without suffix, hence will be appended .html
  // - in the future, it might make sense for each dir to have props that controls
  //   the suffixes ie. "handleTrailingSlashse"
  const expandDirs = [".well-known"];

  // Every file under `dir`, as paths relative to it. Undefined if it
  // holds anything other than files and folders, like a symlink.
  const listDir = (dir: string): string[] | undefined => {
    const files: string[] = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isFile()) {
        files.push(item.name);
        continue;
      }
      if (!item.isDirectory()) return;
      const children = listDir(path.join(dir, item.name));
      if (!children) return;
      files.push(...children.map((file) => path.join(item.name, file)));
    }
    return files;
  };
  // Folders to list file by file, if they fit in the KV budget.
  const listed: { dir: string; keys: string[] }[] = [];

  plan.assets.forEach((copy) => {
    const processDir = (childPath = "", level = 0) => {
      const currentPath = path.join(outputPath, copy.from, childPath);
      fs.readdirSync(currentPath, { withFileTypes: true }).forEach((item) => {
        // File: add to kvEntries
        if (item.isFile()) {
          kvEntries[toPosix(path.join("/", childPath, item.name))] = "s3";
          return;
        }
        // Directory + deep routes: recursively process it
        //   In Next.js, asset requests are prefixed with is /_next/static,
        //   and image optimization requests are prefixed with /_next/image.
        //   We cannot route by 1 level of subdirs (ie. /_next/`), so we need
        //   to route by 2 levels of subdirs.
        // Directory + expand: recursively process it
        if (
          level === 0 &&
          (expandDirs.includes(item.name) || item.name === copy.deepRoute)
        ) {
          processDir(path.join(childPath, item.name), level + 1);
          return;
        }
        // Directory with prerendered routes: add its files, not the
        //   folder, so server routes in the same folder are not
        //   shadowed by S3 (ie. /blog/post.html and /blog/[slug]).
        //   Folders with a key over the KV key size limit are still
        //   routed as a whole.
        const dirPath = toPosix(path.join(childPath, item.name));
        if (
          item.isDirectory() &&
          !(
            copy.versionedSubDir &&
            (dirPath === copy.versionedSubDir ||
              dirPath.startsWith(copy.versionedSubDir + "/"))
          ) &&
          (copy.listFiles ||
            plan.hasStaticRoutes ||
            plan.prerenderedDirs?.length)
        ) {
          const keys = listDir(path.join(currentPath, item.name))?.map((file) =>
            toPosix(path.join("/", dirPath, file)),
          );
          if (
            keys &&
            (copy.listFiles ||
              (level === 0 && plan.prerenderedDirs?.includes(item.name)) ||
              keys.some((key) => key.endsWith(".html"))) &&
            keys.every((key) => Buffer.byteLength(key) <= MAX_KV_KEY_LENGTH)
          ) {
            listed.push({
              dir: toPosix(path.join("/", dirPath)),
              keys,
            });
            return;
          }
        }
        // Directory + NOT expand: add to route
        dirs.push(toPosix(path.join("/", childPath, item.name)));
      });
    };
    processDir();
  });

  // Over the budget, route the folders to S3 as a whole, as before.
  // Each item also stores the `<namespace>:` prefix and the "s3" value.
  const listedBytes = listed
    .flatMap(({ keys }) => keys)
    .reduce((total, key) => total + Buffer.byteLength(key) + 8, 0);
  if (listedBytes <= MAX_LISTED_KV_BYTES) {
    listed.forEach(({ keys }) =>
      keys.forEach((key) => (kvEntries[key] = "s3")),
    );
  } else {
    const dirList = listed.map(({ dir }) => dir).join(", ");
    console.warn(
      `${name}: too many prerendered files to list in the KV store, so server routes in these folders may return 403: ${dirList}`,
    );
    dirs.push(...listed.map(({ dir }) => dir));
  }

  kvEntries["metadata"] = JSON.stringify({
    base: plan.base,
    custom404: plan.custom404,
    s3: {
      domain: bucketDomain,
      dir: plan.assets[0].to ? "/" + plan.assets[0].to : "",
      prefix: pathPrefix && pathPrefix !== "/" ? pathPrefix : "",
      routes: dirs,
    },
    image: imageOptimizerUrl
      ? {
          host: new URL(imageOptimizerUrl!).host,
          route: plan.imageOptimizer!.prefix,
          ...(protectionConfig.mode === "oac" ||
          protectionConfig.mode === "oac-with-edge-signing"
            ? {
                originAccessControlConfig: {
                  enabled: true,
                  signingBehavior: "always",
                  signingProtocol: "sigv4",
                  originType: "lambda",
                },
              }
            : {}),
        }
      : undefined,
    servers: servers.map((s) => [
      new URL(s.url!).host,
      supportedRegions[s.region as keyof typeof supportedRegions].lat,
      supportedRegions[s.region as keyof typeof supportedRegions].lon,
    ]),
    origin: {
      timeouts: {
        readTimeout: toSeconds(timeout),
      },
      ...(protectionConfig.mode === "oac" ||
      protectionConfig.mode === "oac-with-edge-signing"
        ? {
            originAccessControlConfig: {
              enabled: true,
              signingBehavior: "always",
              signingProtocol: "sigv4",
              originType: "lambda",
            },
          }
        : {}),
    },
  } satisfies KV_SITE_METADATA);
  return kvEntries;
}

/** A site's `invalidation` arg. */
export type SiteInvalidation =
  | false
  | {
      wait?: boolean;
      paths?: "all" | "versioned" | string[];
    };

/**
 * The paths a deploy clears from CloudFront's cache, and the version that says
 * when: it changes when the build, or the server's code, does. `undefined` when
 * nothing is cleared.
 *
 * @param serverCodeHashes The hashes of the server functions' code, so a
 * deploy that only changes the server clears the cache too.
 */
export function siteInvalidation(input: {
  invalidation?: SiteInvalidation;
  plan: SitePlan;
  outputPath: string;
  serverCodeHashes: string[];
  imageOptimizerCodeHash?: string;
}) {
  const { plan, outputPath, serverCodeHashes, imageOptimizerCodeHash } = input;
  const invalidationRaw = input.invalidation;
  // Normalize invalidation
  if (invalidationRaw === false) return;
  const invalidation = {
    wait: false,
    paths: "all",
    ...invalidationRaw,
  };

  // We will generate a hash based on the contents of the S3 files with cache enabled.
  // This will be used to determine if we need to invalidate our CloudFront cache.
  const s3Origin = plan.assets;
  const cachedS3Files = s3Origin.filter((file) => file.cached);
  if (cachedS3Files.length === 0) return;

  // Build invalidation paths
  const invalidationPaths: string[] = [];
  if (invalidation.paths === "all") {
    invalidationPaths.push("/*");
  } else if (invalidation.paths === "versioned") {
    cachedS3Files.forEach((item) => {
      if (!item.versionedSubDir) return;
      invalidationPaths.push(
        toPosix(path.join("/", item.to, item.versionedSubDir, "*")),
      );
    });
  } else {
    invalidationPaths.push(...(invalidation?.paths || []));
  }
  if (invalidationPaths.length === 0) return;

  // Build build ID
  let invalidationBuildId: string;
  if (plan.buildId) {
    invalidationBuildId = plan.buildId;
  } else {
    const hash = crypto.createHash("md5");

    // Fold in server bundle hashes so that changes to server-only
    // code (e.g. loaders, handlers) invalidate the CloudFront cache
    // even when no static assets changed.
    serverCodeHashes.forEach((h) => hash.update(h));
    if (imageOptimizerCodeHash) hash.update(imageOptimizerCodeHash);

    cachedS3Files.forEach((item) => {
      // The below options are needed to support following symlinks when building zip files:
      // - nodir: This will prevent symlinks themselves from being copied into the zip.
      // - follow: This will follow symlinks and copy the files within.

      // For versioned files, use file path for digest since file version in name should change on content change
      if (item.versionedSubDir) {
        globSync("**", {
          dot: true,
          nodir: true,
          follow: true,
          cwd: path.resolve(outputPath, item.from, item.versionedSubDir),
        }).forEach((filePath) => hash.update(filePath));
      }

      // For non-versioned files, use file content for digest: its bytes, as
      // a file that isn't text read as text can hash the same after a change
      if (invalidation.paths !== "versioned") {
        globSync("**", {
          ignore: item.versionedSubDir
            ? [toPosix(path.join(item.versionedSubDir, "**"))]
            : undefined,
          dot: true,
          nodir: true,
          follow: true,
          cwd: path.resolve(outputPath, item.from),
        }).forEach((filePath) =>
          hash.update(
            fs.readFileSync(path.resolve(outputPath, item.from, filePath)),
          ),
        );
      }
    });
    invalidationBuildId = hash.digest("hex");
  }

  return {
    paths: invalidationPaths,
    version: invalidationBuildId,
    wait: invalidation.wait,
  };
}

/**
 * The code a server function runs first when it's kept warm: it answers the
 * warmer's calls itself, before the app's own handler is loaded. `context` is
 * in scope in both wrappers. The ping doesn't wait for the event loop to
 * drain: the sandbox keeps the app's sockets and timers from earlier requests
 * open, and the ping would otherwise run until the function times out.
 */
export function serverWarmingInjection(streaming?: boolean) {
  return [
    `if (event.type === "warmer") {`,
    `  context.callbackWaitsForEmptyEventLoop = false;`,
    `  const p = new Promise((resolve) => {`,
    `    setTimeout(() => {`,
    `      resolve({ serverId: "server-" + Math.random().toString(36).slice(2, 8) });`,
    `    }, event.delay);`,
    `  });`,
    ...(streaming
      ? [
          `  const response = await p;`,
          `  responseStream.write(JSON.stringify(response));`,
          `  responseStream.end();`,
          `  return;`,
        ]
      : [`  return p;`]),
    `}`,
  ].join("\n");
}
