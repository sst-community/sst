import path from "path";
import {
  type CustomResourceOptions,
  type Input,
  type Output,
  asset,
  interpolate,
  output,
} from "@pulumi/pulumi";
import type { cloudfront, iam, lambda } from "@pulumi/aws";
import { notAnExistingPart, plain, notAnOptionOf } from "../../args";
import { context } from "../../contract";
import { physicalName } from "../../naming";
import { type Size, toMBs } from "../../size";
import { type DurationSeconds, toSeconds } from "../../duration";
import type { ProtectionConfig } from "../router-code";
import type { Cdn, CdnArgs } from "../v5/cdn";
import { parseLambdaEdgeArn } from "./arn";
import { useProvider } from "./provider";

// What the `Router`, the sites with a server and the `StaticSite` share to set
// up the CloudFront distribution they're served through: a viewer request
// function that routes each request with a key-value store, and what's
// around it.

/** A viewer function's settings in `edge`. */
interface ViewerArgs {
  injection: Input<string>;
  kvStore?: Input<string>;
}

/** A component's `edge`: the code CloudFront runs on requests and responses. */
export interface EdgeArgs {
  viewerRequest?: ViewerArgs;
  viewerResponse?: ViewerArgs;
}

/** A component's `protection`, as it's given. */
export type ProtectionArgs =
  | ProtectionConfig["mode"]
  | {
      mode: "oac-with-edge-signing";
      edgeFunction?: {
        arn?: Input<string>;
        memory?: Input<Size>;
        timeout?: Input<DurationSeconds>;
      };
    };

/** A component's `protection`, as an object. */
export interface Protection {
  mode: ProtectionConfig["mode"];
  edgeFunction?: {
    arn?: Input<string>;
    memory?: Input<Size>;
    timeout?: Input<DurationSeconds>;
  };
}

/**
 * What creates a part: the component's own `part()`, from `this.builder()`.
 * The component declares the part.
 */
interface Creates<K extends string, Args, Resource> {
  part(key: K, args: Args, opts?: CustomResourceOptions): Resource;
}

/** What creates the key-value store, for `routingStore()`. */
export type StoreBuilder = Creates<
  "kvStore",
  cloudfront.KeyValueStoreArgs,
  cloudfront.KeyValueStore
>;

/** What creates the viewer response function. */
export type ResponseFunctionBuilder = Creates<
  "responseFunction",
  cloudfront.FunctionArgs,
  cloudfront.Function
>;

/** What creates the parts of a distribution that serves a server. */
export type DistributionBuilder = StoreBuilder &
  ResponseFunctionBuilder &
  Creates<"requestFunction", cloudfront.FunctionArgs, cloudfront.Function> &
  Creates<"cachePolicy", cloudfront.CachePolicyArgs, cloudfront.CachePolicy> &
  Creates<"edgeRole", iam.RoleArgs, iam.Role> &
  Creates<"edgeFunction", lambda.FunctionArgs, lambda.Function> &
  Creates<"cdn", CdnArgs, Cdn>;

/**
 * A component's `protection`, checked: it and its `edgeFunction` decide what's
 * created, so they're plain values. An `edgeFunction.arn` that's given as a
 * string has to be a Lambda@Edge function's qualified ARN.
 *
 * @param option An arg, as the start of an error message: `The "edge" of the
 * "Web" Astro site`.
 */
export function protectionOf(
  protection: ProtectionArgs | undefined,
  option: (arg: string) => string,
): Protection {
  const given = plain(protection, option("protection"));
  if (!given) return { mode: "none" };
  if (typeof given === "string") return { mode: given };
  plain(given.edgeFunction, option("protection.edgeFunction"));
  const arn = given.edgeFunction?.arn;
  if (typeof arn === "string") parseLambdaEdgeArn(arn);
  return given;
}

/**
 * A component's `edge`, checked: it and its viewer functions' settings decide
 * which functions are created, so they're plain values. SST 4's `kvStores` is
 * refused: a CloudFront function takes one key-value store.
 */
export function edgeOf(
  edge: EdgeArgs | undefined,
  option: (arg: string) => string,
  owner: string,
): EdgeArgs {
  const given = plain(edge, option("edge")) ?? {};
  for (const viewer of ["viewerRequest", "viewerResponse"] as const) {
    const settings = plain(given[viewer], option(`edge.${viewer}`));
    notAnOptionOf(
      (settings as { kvStores?: unknown } | undefined)?.kvStores,
      `edge.${viewer}.kvStores`,
      `Use "kvStore": a CloudFront function takes one key-value store.`,
      owner,
    );
  }
  return given;
}

/**
 * The key-value store the viewer request function routes with: the one
 * `edge.viewerRequest.kvStore` names, or one the component creates.
 *
 * @param existing The component's `existing`, which can't give the store too.
 */
export function routingStore(
  builder: StoreBuilder,
  edge: EdgeArgs,
  existing: object | undefined,
  owner: string,
): Output<string> {
  const given = edge.viewerRequest?.kvStore;
  if (given === undefined) return builder.part("kvStore", {}).arn;
  notAnExistingPart(
    existing,
    "kvStore",
    owner,
    `It routes with the store "edge.viewerRequest.kvStore" names. Give the store in one of them.`,
  );
  return output(given);
}

/**
 * The viewer response function, with `edge.viewerResponse.injection`: the
 * user's code, and nothing else.
 */
export function viewerResponseFunction(
  builder: ResponseFunctionBuilder,
  viewerResponse: ViewerArgs | undefined,
) {
  if (!viewerResponse?.injection) return;
  return builder.part("responseFunction", {
    runtime: "cloudfront-js-2.0",
    keyValueStoreAssociations: viewerResponse.kvStore
      ? [viewerResponse.kvStore]
      : [],
    code: interpolate`
import cf from "cloudfront";
async function handler(event) {
  ${viewerResponse.injection}
  return event.response;
}`,
  });
}

/**
 * Create the distribution a router or a site with a server is served through:
 * a placeholder origin, with a viewer request function that routes each
 * request with the key-value store, the viewer response function, the cache
 * policy for the server's responses, and with `protection:
 * "oac-with-edge-signing"`, the Lambda@Edge function that signs requests.
 *
 * @param name The component's name, which its resources are named after.
 * @param owner The component, in messages: `the "Web" Astro site`.
 * @param existing The component's `existing`, which can't give what another
 * arg gives.
 * @param kvStoreArn The store the request function routes with, from
 * `routingStore()`.
 * @param requestCode The viewer request function's code.
 * @param cachePolicy The cache policy the user gave, in place of one that's
 * created.
 */
export function createServerDistribution(
  builder: DistributionBuilder,
  input: {
    name: string;
    owner: string;
    existing?: object;
    domain?: CdnArgs["domain"];
    protection: Protection;
    edge: EdgeArgs;
    kvStoreArn: Output<string>;
    requestCode: Output<string>;
    cachePolicy?: Input<string>;
    tags?: CdnArgs["tags"];
    webAclArn?: CdnArgs["webAclArn"];
  },
): Cdn {
  const { name, owner, existing } = input;
  const requestFunction = builder.part("requestFunction", {
    runtime: "cloudfront-js-2.0",
    keyValueStoreAssociations: [input.kvStoreArn],
    code: input.requestCode,
  });
  const responseFunction = viewerResponseFunction(
    builder,
    input.edge.viewerResponse,
  );
  const cachePolicyId = cachePolicyOf();
  const edgeSigner = edgeSignerOf();

  return builder.part("cdn", {
    comment: `${name} app`,
    domain: input.domain,
    origins: [
      {
        originId: "default",
        domainName: "placeholder.sst.dev",
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: "http-only",
          originReadTimeout: 20,
          originSslProtocols: ["TLSv1.2"],
        },
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: "default",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: [
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT",
      ],
      cachedMethods: ["GET", "HEAD"],
      compress: true,
      cachePolicyId,
      // CloudFront's Managed-AllViewerExceptHostHeader policy
      originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
      functionAssociations: [
        { eventType: "viewer-request", functionArn: requestFunction.arn },
        ...(responseFunction
          ? [
              {
                eventType: "viewer-response",
                functionArn: responseFunction.arn,
              },
            ]
          : []),
      ],
      lambdaFunctionAssociations: edgeSigner
        ? [
            {
              eventType: "origin-request",
              lambdaArn: edgeSigner,
              includeBody: true,
            },
          ]
        : [],
    },
    ...(input.tags && { tags: input.tags }),
    ...(input.webAclArn && { webAclArn: input.webAclArn }),
  });

  // The policy the user gave, or one that caches by the headers a server's
  // responses vary on
  function cachePolicyOf() {
    if (input.cachePolicy !== undefined) {
      notAnExistingPart(
        existing,
        "cachePolicy",
        owner,
        `It uses the policy "cachePolicy" names. Give the policy in one of them.`,
      );
      return input.cachePolicy;
    }
    return builder.part("cachePolicy", {
      comment: "SST server response cache policy",
      defaultTtl: 0,
      maxTtl: 31536000, // 1 year
      minTtl: 0,
      parametersInCacheKeyAndForwardedToOrigin: {
        cookiesConfig: {
          cookieBehavior: "none",
        },
        headersConfig: {
          headerBehavior: "whitelist",
          headers: {
            items: ["x-open-next-cache-key", "x-forwarded-host"],
          },
        },
        queryStringsConfig: {
          queryStringBehavior: "all",
        },
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
      },
    }).id;
  }

  // The Lambda@Edge function that signs requests to function URLs: the one
  // `protection.edgeFunction.arn` names, the user's in `existing`, or one
  // that's created with its role
  function edgeSignerOf() {
    const { protection } = input;
    if (protection.mode !== "oac-with-edge-signing") return;
    const settings = protection.edgeFunction;
    if (settings?.arn) {
      notAnExistingPart(
        existing,
        "edgeFunction",
        owner,
        `It signs with the function "protection.edgeFunction.arn" names. Give the function in one of them.`,
      );
      return settings.arn;
    }

    // CloudFront only takes Lambda@Edge functions from us-east-1
    const us = { provider: useProvider("us-east-1") };
    // The user's, which `part()` returns as it is, looked up in us-east-1
    // when it's given by name. It isn't created, so it needs no role.
    if ((existing as { edgeFunction?: unknown })?.edgeFunction !== undefined)
      return builder.part("edgeFunction", {} as lambda.FunctionArgs, us)
        .qualifiedArn;

    const role = builder.part(
      "edgeRole",
      {
        name: physicalName(64, `${name}EdgeRole`),
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: {
                Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
              },
            },
          ],
        }),
        managedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
      { ignoreChanges: ["name"] },
    );
    return builder.part(
      "edgeFunction",
      {
        name: physicalName(64, `${name}EdgeFn`),
        runtime: "nodejs24.x",
        handler: "index.handler",
        role: role.arn,
        code: new asset.FileArchive(
          path.join(context().paths.platform, "dist", "oac-edge-signer"),
        ),
        publish: true,
        timeout: output(settings?.timeout).apply((timeout) =>
          timeout ? toSeconds(timeout) : 5,
        ),
        memorySize: output(settings?.memory).apply((memory) =>
          memory ? toMBs(memory) : 128,
        ),
        description: `${name} Lambda@Edge function for OAC request signing`,
      },
      { ...us, ignoreChanges: ["name"] },
    ).qualifiedArn;
  }
}
