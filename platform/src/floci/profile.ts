/** Initial Floci compatibility policy. Extend alongside emulator integration tests. */
export const profile = {
  version: "floci-2.3.0-v1",
  flociVersion: "2.3.0",
  services: [
    "s3",
    "dynamodb",
    "sqs",
    "lambda",
    "iam",
    "sts",
    "ssm",
    "ecr",
    "kms",
    "cloudwatchlogs",
  ],
  components: {
    "sst:aws:Function":
      "handler runtime name description timeout memory storage environment permissions policies link logging architecture url nodejs bundle copyFiles injections tags live dev transform _skipMetadata _skipHint",
    "sst:aws:Bucket": "public access policy enforceHttps cors transform",
    "sst:aws:Dynamo":
      "fields primaryIndex globalIndexes localIndexes ttl deletionProtection transform",
    "sst:aws:Queue": "fifo delay visibilityTimeout dlq transform",
    "sst:aws:QueueLambdaSubscriber": "queue subscriber batch filters transform",
    "sst:sst:LinkRef": "properties include",
  } as Record<string, string>,
  resources: {
    "aws:s3/bucket:Bucket": "bucket bucketPrefix forceDestroy tags",
    "aws:s3/bucketV2:BucketV2": "bucket bucketPrefix forceDestroy tags",
    "aws:s3/bucketPolicy:BucketPolicy": "bucket policy",
    "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock":
      "bucket blockPublicAcls blockPublicPolicy ignorePublicAcls restrictPublicBuckets",
    "aws:s3/bucketCorsConfiguration:BucketCorsConfiguration":
      "bucket corsRules",
    "aws:s3/bucketCorsConfigurationV2:BucketCorsConfigurationV2":
      "bucket corsRules",
    "aws:s3/bucketObjectv2:BucketObjectv2":
      "bucket key source content contentBase64 contentType cacheControl etag sourceHash tags",
    "aws:dynamodb/table:Table":
      "name attributes hashKey rangeKey billingMode readCapacity writeCapacity globalSecondaryIndexes localSecondaryIndexes ttl deletionProtectionEnabled pointInTimeRecovery streamEnabled tags",
    "aws:sqs/queue:Queue":
      "name namePrefix fifoQueue contentBasedDeduplication deduplicationScope fifoThroughputLimit delaySeconds visibilityTimeoutSeconds redrivePolicy receiveWaitTimeSeconds messageRetentionSeconds maxMessageSize sqsManagedSseEnabled tags",
    "aws:sqs/queuePolicy:QueuePolicy": "queueUrl policy",
    "aws:iam/role:Role":
      "name namePrefix assumeRolePolicy inlinePolicies managedPolicyArns description path forceDetachPolicies maxSessionDuration tags",
    "aws:iam/rolePolicy:RolePolicy": "name namePrefix role policy",
    "aws:iam/rolePolicyAttachment:RolePolicyAttachment": "role policyArn",
    "aws:iam/policy:Policy": "name namePrefix policy description path tags",
    "aws:cloudwatch/logGroup:LogGroup":
      "name namePrefix retentionInDays skipDestroy tags",
    "aws:lambda/function:Function":
      "name description role timeout memorySize ephemeralStorage environment architectures loggingConfig tags publish reservedConcurrentExecutions packageType s3Bucket s3Key s3ObjectVersion handler runtime code sourceCodeHash",
    "aws:lambda/functionUrl:FunctionUrl":
      "functionName authorizationType cors invokeMode qualifier",
    "aws:lambda/permission:Permission":
      "action function principal statementId statementIdPrefix sourceArn sourceAccount qualifier functionUrlAuthType invokedViaFunctionUrl",
    "aws:lambda/eventSourceMapping:EventSourceMapping":
      "functionName eventSourceArn batchSize maximumBatchingWindowInSeconds functionResponseTypes filterCriteria enabled",
    "aws:ssm/parameter:Parameter": "name type value description overwrite tags",
    "aws:ecr/repository:Repository":
      "name imageTagMutability forceDelete imageScanningConfiguration tags",
    "aws:kms/key:Key":
      "description deletionWindowInDays enableKeyRotation policy tags",
    "random:index/randomBytes:RandomBytes": "length keepers",
  } as Record<string, string>,
  invokes: new Set([
    "aws:index/getRegion:getRegion",
    "aws:index/getPartition:getPartition",
    "aws:index/getCallerIdentity:getCallerIdentity",
    "aws:iam/getPolicyDocument:getPolicyDocument",
  ]),
};

export interface Violation {
  path: string;
  operation: string;
  reason: string;
  fix: string;
}

export function violation(
  path: string,
  operation: string,
  detail: string,
): Violation {
  return {
    path,
    operation,
    reason: `${detail} is not supported by ${profile.version}.`,
    fix: "Remove this resource or option from the Floci app. No AWS fallback was attempted.",
  };
}

export function checkKeys(
  path: string,
  operation: string,
  props: Record<string, unknown>,
  allowed: string,
) {
  const keys = new Set(allowed.split(" "));
  return Object.entries(props)
    .filter(
      ([key, value]) => value !== undefined && value !== null && !keys.has(key),
    )
    .map(([key]) => violation(path, `${operation}.${key}`, `Option ${key}`));
}

const corsKeys =
  "allowCredentials allowHeaders allowOrigins allowMethods exposeHeaders maxAge";
const componentNested: Record<string, Record<string, string>> = {
  "sst:aws:Function": {
    url: "authorization cors",
    "url.cors": corsKeys,
    logging: "retention logGroup format",
    nodejs:
      "plugins loader install banner esbuild minify format sourcemap splitting",
  },
  "sst:aws:Bucket": { cors: corsKeys },
  "sst:aws:Dynamo": {
    primaryIndex: "hashKey rangeKey",
    "globalIndexes.*": "hashKey rangeKey projection",
    "localIndexes.*": "rangeKey projection",
  },
  "sst:aws:Queue": { fifo: "contentBasedDeduplication", dlq: "queue retry" },
  "sst:aws:QueueLambdaSubscriber": { batch: "size window partialResponses" },
};

function checkNested(
  path: string,
  operation: string,
  props: Record<string, any>,
  rules: Record<string, string>,
) {
  const problems: Violation[] = [];
  for (const [key, allowed] of Object.entries(rules)) {
    function visit(value: any, segments: string[], current: string) {
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) return;
      if (!segments.length) {
        problems.push(...checkKeys(path, current, value, allowed));
        return;
      }
      const [head, ...tail] = segments;
      if (head === "*")
        for (const [name, child] of Object.entries(value))
          visit(child, tail, `${current}.${name}`);
      else visit(value[head], tail, `${current}.${head}`);
    }
    visit(props, key.split("."), operation);
  }
  return problems;
}

export const resolvedComponentOptions = [
  "dev",
  "live",
  "runtime",
  "url",
  "access",
  "logging",
  "nodejs",
  "cors",
  "primaryIndex",
  "globalIndexes",
  "localIndexes",
  "fifo",
  "dlq",
  "batch",
];

export function checkComponent(
  type: string,
  name: string,
  props: Record<string, any> = {},
): Violation[] {
  const path = `${name} (${type})`;
  if (!Object.hasOwn(profile.components, type))
    return [violation(path, "component", type)];
  const problems = checkKeys(path, "option", props, profile.components[type]);
  problems.push(
    ...checkNested(path, "option", props, componentNested[type] || {}),
  );
  if (type === "sst:aws:Function") {
    for (const key of ["dev", "live"]) {
      if (props[key] === false)
        problems.push(
          violation(path, `option.${key}`, "Disabling the local live worker"),
        );
    }
    if (
      typeof props.runtime === "string" &&
      !/^nodejs(20|22|24)\.x$/.test(props.runtime)
    )
      problems.push(
        violation(path, "option.runtime", `Runtime ${props.runtime}`),
      );
  }
  if (
    type === "sst:aws:Bucket" &&
    typeof props.access === "string" &&
    props.access !== "public"
  )
    problems.push(violation(path, "option.access", `Access ${props.access}`));
  return problems;
}

export function checkResource(
  type: string,
  name: string,
  props: Record<string, any> = {},
  internalBridge = false,
): Violation[] {
  const path = `${name} (${type})`;
  if (
    type === "pulumi:pulumi:Stack" ||
    type === "pulumi:providers:aws" ||
    type === "pulumi:providers:random" ||
    type === "pulumi:providers:pulumi-nodejs"
  )
    return [];
  if (Object.hasOwn(profile.components, type)) return [];
  if (!Object.hasOwn(profile.resources, type))
    return [violation(path, "resource", type)];
  const problems = checkKeys(
    path,
    "resource.option",
    props,
    profile.resources[type] + " urn id",
  );
  if (type === "aws:lambda/function:Function") {
    if (
      props.runtime !== undefined &&
      !/^nodejs(20|22|24)\.x$/.test(props.runtime) &&
      !(internalBridge && props.runtime === "provided.al2023")
    )
      problems.push(
        violation(path, "resource.runtime", `Runtime ${props.runtime}`),
      );
    problems.push(
      ...checkNested(path, "resource.option", props, {
        ephemeralStorage: "size",
        environment: "variables",
        loggingConfig: "logFormat logGroup",
      }),
    );
  }
  if (
    type === "aws:lambda/functionUrl:FunctionUrl" &&
    props.invokeMode !== undefined &&
    props.invokeMode !== "BUFFERED"
  )
    problems.push(
      violation(path, "resource.invokeMode", `Invoke mode ${props.invokeMode}`),
    );
  if (type === "aws:dynamodb/table:Table" && props.streamEnabled === true)
    problems.push(
      violation(path, "resource.streamEnabled", "DynamoDB streams"),
    );
  if (
    type === "aws:lambda/function:Function" &&
    props.packageType &&
    props.packageType !== "Zip"
  )
    problems.push(
      violation(
        path,
        "resource.packageType",
        `Package type ${props.packageType}`,
      ),
    );
  return problems;
}

export function checkInvoke(token: string): Violation[] {
  return profile.invokes.has(token) ? [] : [violation(token, "invoke", token)];
}
