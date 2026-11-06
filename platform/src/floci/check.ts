import {
  output,
  runtime,
  type CustomResourceOptions,
  type Resource,
} from "@pulumi/pulumi";
import { writeFileSync } from "fs";
import {
  checkComponent,
  checkKeys,
  resolvedComponentOptions,
  checkInvoke,
  checkResource,
  profile,
  violation,
  type Violation,
} from "./profile";

let violations: Violation[] = [];
const seen = new Set<string>();
const trustedDynamic = new WeakSet<Resource>();
const trustedDynamicNames = new Set<string>();
const functionNames = new Set<string>();

/** Only SST constructors backed by the allowlisted Go RPC implementations use this. */
export function flociDynamicOptions(
  opts: CustomResourceOptions = {},
): CustomResourceOptions {
  if (!isFloci()) return opts;
  return {
    ...opts,
    transformations: [
      ...(opts.transformations || []),
      (args) => {
        trustedDynamic.add(args.resource);
        trustedDynamicNames.add(args.name);
        return undefined;
      },
    ],
  };
}
export function isFloci() {
  return Boolean(process.env.SST_FLOCI_ENDPOINT);
}
export function isFlociPreflight() {
  return isFloci() && process.env.SST_FLOCI_PREFLIGHT === "1";
}

function saveReport() {
  if (process.env.SST_FLOCI_REPORT)
    writeFileSync(
      process.env.SST_FLOCI_REPORT,
      JSON.stringify({ profile: profile.version, violations }, null, 2),
    );
}

export function enforce(problems: Violation[], alwaysThrow = false) {
  if (!isFloci() || !problems.length) return;
  for (const problem of problems) {
    const key = JSON.stringify(problem);
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push(problem);
  }
  saveReport();
  if (alwaysThrow || !isFlociPreflight())
    throw new Error(
      problems
        .map((p) => `${p.path} → ${p.operation}: ${p.reason} ${p.fix}`)
        .join("\n"),
    );
}

export function checkFlociComponent(
  type: string,
  name: string,
  props: Record<string, any> = {},
) {
  if (!isFloci()) return;
  enforce(checkComponent(type, name, props));
  if (type === "sst:aws:Function") functionNames.add(name);
  // Inputs that resolve during an apply must be checked again before up can proceed.
  for (const key of resolvedComponentOptions) {
    if (props[key] === undefined) continue;
    output(props[key]).apply((value) => {
      enforce(checkComponent(type, name, { [key]: value }));
    });
  }
}

export function checkFlociRegion(region: string) {
  if (!isFloci()) return;
  const expected = process.env.AWS_REGION || "us-east-1";
  if (region !== expected)
    enforce(
      [
        violation(
          "AWS provider",
          "region",
          `Region ${region}; expected ${expected}`,
        ),
      ],
      true,
    );
}

export function registerFlociChecks() {
  if (!isFloci()) return;
  violations = [];
  seen.clear();
  saveReport();
  trustedDynamicNames.clear();
  functionNames.clear();
  runtime.registerStackTransformation((args) => {
    if (!isFloci()) return;
    if (
      args.type === "pulumi-nodejs:dynamic:Resource" &&
      !trustedDynamic.has(args.resource)
    ) {
      // Untrusted dynamic providers can execute arbitrary code even during preview.
      enforce(
        [violation(args.name, "resource", "Untrusted dynamic provider")],
        true,
      );
    }
    return undefined;
  });
  runtime.registerResourceTransform(async (args) => {
    if (!isFloci()) return;
    const parent = args.opts.parent
      ? await new Promise<string>((resolve) => {
          output(args.opts.parent!.urn).apply(resolve);
        })
      : undefined;
    const problems =
      args.type === "pulumi-nodejs:dynamic:Resource" &&
      trustedDynamicNames.has(args.name)
        ? []
        : checkResource(
            args.type,
            args.name,
            args.props,
            Boolean(
              parent &&
                parent.split("::").at(-2)?.split("$").at(-1) ===
                  "sst:aws:Function" &&
                functionNames.has(parent.split("::").at(-1)!) &&
                args.name === `${parent.split("::").at(-1)}Function` &&
                process.env.SST_FLOCI_BRIDGE,
            ),
          );
    if (typeof parent === "string")
      for (const problem of problems)
        problem.path = `${parent} → ${problem.path}`;
    enforce(problems);
    if (args.type === "pulumi:providers:aws") {
      const props = args.props;
      checkFlociRegion(props.region || process.env.AWS_REGION || "us-east-1");
      enforce(
        checkKeys(
          args.name,
          "provider",
          props,
          "region accessKey secretKey defaultTags endpoints skipCredentialsValidation skipMetadataApiCheck skipRequestingAccountId skipRegionValidation s3UsePathStyle version",
        ),
        true,
      );
      // Apply to explicit and automatically created providers alike. Never inherit credentials.
      return {
        opts: args.opts,
        props: {
          ...props,
          accessKey: "test",
          secretKey: "test",
          token: "",
          region: process.env.AWS_REGION || "us-east-1",
          skipCredentialsValidation: true,
          skipMetadataApiCheck: true,
          skipRequestingAccountId: true,
          skipRegionValidation: true,
          s3UsePathStyle: true,
          endpoints: [
            Object.fromEntries(
              profile.services.map((service) => [
                service,
                process.env.SST_FLOCI_ENDPOINT,
              ]),
            ),
          ],
        },
      };
    }
    return undefined;
  });
  runtime.registerInvokeTransform((args) => {
    if (!isFloci()) return;
    // An invoke runs even during preview: never pass an unsupported token to a provider.
    enforce(checkInvoke(args.token), true);
    return undefined;
  });
}
