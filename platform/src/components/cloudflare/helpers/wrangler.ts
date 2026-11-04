import fs from "fs";
import path from "path";

export type WranglerCompatibility = {
  date: string;
  flags: string[];
};

export type WranglerLinkInclude = {
  type: string;
  binding?: string;
  properties?: Record<string, unknown>;
};

export type WranglerLink = {
  name: string;
  include: WranglerLinkInclude[];
  properties?: Record<string, unknown>;
};

export function createWranglerConfig(input: {
  appName: string;
  appStage: string;
  name: string;
  frameworkConfig?: Record<string, any>;
  compatibility: WranglerCompatibility;
  environment?: Record<string, string>;
  links?: WranglerLink[];
  accountId?: string;
}) {
  const config: Record<string, any> = {
    ...(input.frameworkConfig ?? {}),
    name: sanitizeWranglerName(`sst-${input.appStage}-${input.name}`),
    compatibility_date: input.compatibility.date,
    compatibility_flags: input.compatibility.flags,
  };

  if (input.accountId) {
    config.account_id = input.accountId;
  }

  const vars: Record<string, string> = {
    ...(input.environment ?? {}),
    SST_RESOURCE_App: JSON.stringify({
      name: input.appName,
      stage: input.appStage,
    }),
  };
  const kvNamespaces: Record<string, any>[] = [];
  const r2Buckets: Record<string, any>[] = [];
  const d1Databases: Record<string, any>[] = [];
  const hyperdrives: Record<string, any>[] = [];
  const services: Record<string, any>[] = [];
  const queueProducers: Record<string, any>[] = [];
  const workflows: Record<string, any>[] = [];
  const rateLimits: Record<string, any>[] = [];
  let ai: Record<string, any> | undefined;
  let versionMetadata: Record<string, any> | undefined;

  for (const link of input.links ?? []) {
    const binding = link.include.find(
      (item) => item.type === "cloudflare.binding",
    );
    // Links without a native Cloudflare binding (Secret, sst.aws.*, custom
    // Linkable, etc.) are surfaced as JSON-stringified vars so they match
    // the `secret_text` deploy path handled in `worker.ts buildBindings`.
    if (!binding) {
      vars[`SST_RESOURCE_${link.name}`] = JSON.stringify(link.properties ?? {});
      continue;
    }

    const properties = binding.properties ?? {};
    // A binding to what isn't created yet, like a namespace in a new stage's
    // preview, has no id to give, so it's left out
    const known = (...keys: string[]) =>
      keys.every((key) => typeof properties[key] === "string");
    switch (binding.binding) {
      case "aiBindings":
        ai = {
          binding: link.name,
          remote: true,
        };
        break;
      case "kvNamespaceBindings":
        if (!known("namespaceId")) break;
        kvNamespaces.push({
          binding: link.name,
          id: properties.namespaceId,
          remote: true,
        });
        break;
      case "secretTextBindings":
      case "plainTextBindings":
        if (!known("text")) break;
        vars[link.name] = properties.text as string;
        break;
      case "serviceBindings":
        if (!known("service")) break;
        services.push({
          binding: link.name,
          service: properties.service,
          remote: true,
        });
        break;
      case "queueBindings":
        if (!known("queueName")) break;
        queueProducers.push({
          binding: link.name,
          queue: properties.queueName,
          remote: true,
        });
        break;
      case "r2BucketBindings":
        if (!known("bucketName")) break;
        r2Buckets.push({
          binding: link.name,
          bucket_name: properties.bucketName,
          // A bucket outside any jurisdiction gives none
          ...(known("jurisdiction")
            ? { jurisdiction: properties.jurisdiction }
            : {}),
          remote: true,
        });
        break;
      case "d1DatabaseBindings":
        if (!known("id")) break;
        d1Databases.push({
          binding: link.name,
          database_id: properties.id,
          remote: true,
        });
        break;
      case "hyperdriveBindings":
        if (!known("id")) break;
        hyperdrives.push({
          binding: link.name,
          id: properties.id,
        });
        break;
      case "versionMetadataBindings":
        versionMetadata = {
          binding: link.name,
        };
        break;
      case "workflowBindings":
        if (!known("workflowName", "className", "scriptName")) break;
        workflows.push({
          binding: link.name,
          name: properties.workflowName,
          class_name: properties.className,
          script_name: properties.scriptName,
          remote: true,
        });
        break;
      case "rateLimitBindings":
        if (!known("namespaceId")) break;
        rateLimits.push({
          name: link.name,
          namespace_id: properties.namespaceId,
          simple: properties.simple,
        });
        break;
    }
  }

  if (Object.keys(vars).length > 0) {
    config.vars = vars;
  }
  if (kvNamespaces.length > 0) {
    config.kv_namespaces = kvNamespaces;
  }
  if (r2Buckets.length > 0) {
    config.r2_buckets = r2Buckets;
  }
  if (d1Databases.length > 0) {
    config.d1_databases = d1Databases;
  }
  if (hyperdrives.length > 0) {
    config.hyperdrive = hyperdrives;
  }
  if (services.length > 0) {
    config.services = services;
  }
  if (queueProducers.length > 0) {
    config.queues = {
      producers: queueProducers,
    };
  }
  if (ai) {
    config.ai = ai;
  }
  if (versionMetadata) {
    config.version_metadata = versionMetadata;
  }
  if (workflows.length > 0) {
    config.workflows = workflows;
  }
  if (rateLimits.length > 0) {
    config.rate_limits = rateLimits;
  }

  return config;
}

export function writeWranglerConfig(args: {
  workDir: string;
  stage: string;
  name: string;
  config: Record<string, any>;
}) {
  const wranglerPath = path.join(
    args.workDir,
    "wrangler",
    args.stage,
    `${args.name}.jsonc`,
  );
  const contents = JSON.stringify(args.config, null, 2);

  fs.mkdirSync(path.dirname(wranglerPath), { recursive: true });
  if (
    !fs.existsSync(wranglerPath) ||
    fs.readFileSync(wranglerPath, "utf-8") !== contents
  ) {
    fs.writeFileSync(wranglerPath, contents);
  }

  return wranglerPath;
}

const wranglerNameRegex = /[^a-z0-9-]+/g;

function sanitizeWranglerName(input: string) {
  const value = input.toLowerCase().replaceAll(wranglerNameRegex, "-");
  return value.replace(/^-+|-+$/g, "") || "sst";
}
