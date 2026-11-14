/**
 * SST's dev loop for a plain Pulumi program: `sst pulumi dev` deploys the
 * program's stack with `pulumi up`, runs the functions `sst.dev.yaml` names on
 * this machine, and runs its dev commands. Pulumi does everything else.
 *
 * Import it once, first, before the program makes any resource. Under
 * `sst pulumi dev` it registers one transform for the whole stack, which asks
 * `sst pulumi dev` about each function and role as the program makes it.
 * Outside `sst pulumi dev` it does nothing, so a stack deployed with plain
 * `pulumi up` has nothing of SST in it.
 *
 * @example
 * ```ts
 * import "sst/pulumi";
 * import * as aws from "@pulumi/aws";
 * ```
 *
 * @packageDocumentation
 */
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import http from "node:http";

/**
 * Whether the program is running under `sst pulumi dev`, which deploys it to a dev
 * stack. Use it for what's different in dev: a local database in place of
 * one in the cloud, or the frontend's dev server in place of the deployed
 * site. It's `process.env.SST_DEV === "true"`, which a program can read
 * without importing anything.
 *
 * @example
 * ```ts
 * import { dev } from "sst/pulumi";
 *
 * const db = dev ? { host: "localhost", port: "5432" } : createDatabase();
 * ```
 */
export const dev =
  process.env.SST_DEV === "true" && Boolean(process.env.SST_SERVER);

/** Where `sst pulumi dev` is, with its token, read with {@link dev}. */
const server = process.env.SST_SERVER;

/**
 * What a function is deployed as in `sst pulumi dev`: the stub, which passes its
 * invocations to `sst pulumi dev`. The CLI says what it is.
 */
interface Stub {
  code: string;
  handler: string;
  runtime: string;
  architectures: string[];
  environment: Record<string, string>;
  permissions: { actions: string[]; resources: string[] }[];
}

/** Calls `sst pulumi dev`, at the address it gives the program. */
function call<T>(method: string, args: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(server + "/rpc");
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200)
            return reject(
              new Error(
                `sst pulumi dev answered ${method} with ${response.statusCode}: ${data}`,
              ),
            );
          try {
            const body = JSON.parse(data);
            if (body.error) return reject(new Error(body.error));
            resolve(body.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(0);
    request.end(JSON.stringify({ jsonrpc: "1.0", method, params: [args] }));
  });
}

/**
 * The transform the import registers for the whole stack under `sst pulumi dev`. A
 * function `sst.dev.yaml` names is deployed as the stub, and a role one of its
 * dev commands runs as lets the developer's account take it. Everything else
 * is left as it is.
 *
 * @internal
 */
export const transform: pulumi.ResourceTransform = async (args) => {
  if (args.type === "aws:lambda/function:Function") return live(args);
  if (args.type === "aws:iam/role:Role") return trust(args);
  return undefined;
};

if (dev) {
  // registerStackTransform is its name from @pulumi/pulumi 3.118 to 3.120.
  // The package's peer range doesn't hold an app to a version, so an older one
  // is refused here, where it matters.
  const register =
    pulumi.runtime.registerResourceTransform ??
    pulumi.runtime.registerStackTransform;
  if (!register)
    throw new Error(
      "`sst pulumi dev` needs @pulumi/pulumi 3.118.0 or newer, and this program has an older one.",
    );
  register(transform);
}

/**
 * The nearest of SST's components a resource is made in, by its type and name.
 * SST's components run their functions in `sst pulumi dev` themselves, deploying
 * the stub where it's needed, so `sst pulumi dev` is only told of such a function.
 */
function sstComponent(
  parent: pulumi.Resource | undefined,
): { type: string; name: string } | undefined {
  // Pulumi keeps each resource's type, name and parent on it
  type Made = {
    __pulumiType?: string;
    __name?: string;
    __parentResource?: Made;
  };
  for (
    let made = parent as Made | undefined;
    made;
    made = made.__parentResource
  )
    if (made.__pulumiType?.startsWith("sst:"))
      return { type: made.__pulumiType, name: made.__name ?? "" };
  return undefined;
}

/**
 * A function `sst.dev.yaml` names, deployed as a stub that passes its
 * invocations to this machine, where `sst pulumi dev` runs it from its source with
 * its own environment and the credentials of its own role. Its role is let
 * reach `sst pulumi dev`.
 */
async function live({
  name,
  props,
  opts,
}: pulumi.ResourceTransformArgs): Promise<
  pulumi.ResourceTransformResult | undefined
> {
  const component = sstComponent(opts.parent);
  const answer = await call<{ live: boolean; stub?: Stub }>(
    "PulumiDev.Function",
    {
      name,
      runtime: typeof props.runtime === "string" ? props.runtime : "",
      // its stub is a zip, and a function can't change from an image to a
      // zip without being replaced
      image: props.packageType === "Image" || Boolean(props.imageUri),
      ...(component ? { component } : {}),
    },
  );
  if (!answer.live || !answer.stub) return undefined;
  const stub = answer.stub;

  if (stub.permissions.length > 0) {
    if (!props.role)
      throw new Error(
        `The "${name}" function has no role, which sst pulumi dev's stub needs to reach it.`,
      );
    new aws.iam.RolePolicy(
      `${name}SstDev`,
      {
        role: pulumi
          .output(props.role as pulumi.Input<string>)
          .apply((arn) => arn.split("/").pop()!),
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: stub.permissions.map((permission) => ({
            Effect: "Allow",
            Action: permission.actions,
            Resource: permission.resources,
          })),
        }),
      },
      { parent: opts.parent, provider: opts.provider },
    );
  }

  // The code is the stub's, and its runtime has no SnapStart
  const {
    s3Bucket,
    s3Key,
    s3ObjectVersion,
    sourceCodeHash,
    snapStart,
    ...kept
  } = props;
  return propsOnly({
    ...kept,
    packageType: "Zip",
    code: new pulumi.asset.FileArchive(stub.code),
    handler: stub.handler,
    runtime: stub.runtime,
    architectures: stub.architectures,
    environment: pulumi
      .output(
        props.environment as
          | pulumi.Input<{ variables?: Record<string, string> }>
          | undefined,
      )
      .apply((environment) => ({
        variables: { ...environment?.variables, ...stub.environment },
      })),
  });
}

/**
 * A role one of `sst.dev.yaml`'s dev commands runs as, which lets the
 * developer's account take it, so `sst pulumi dev` can run the command with its
 * credentials.
 */
async function trust({
  name,
  props,
  opts,
}: pulumi.ResourceTransformArgs): Promise<
  pulumi.ResourceTransformResult | undefined
> {
  const answer = await call<{ trust: boolean }>("PulumiDev.Role", { name });
  if (!answer.trust) return undefined;
  const identity = aws.getCallerIdentityOutput(
    {},
    { parent: opts.parent, provider: opts.provider },
  );
  return propsOnly({
    ...props,
    assumeRolePolicy: pulumi
      .all([props.assumeRolePolicy, identity])
      .apply(([document, identity]) => {
        const parsed =
          typeof document === "string"
            ? JSON.parse(document)
            : structuredClone(document ?? {});
        const partition = identity.arn.split(":")[1];
        // a policy can give one statement on its own
        const statements = parsed.Statement ?? [];
        parsed.Statement = [
          ...(Array.isArray(statements) ? statements : [statements]),
          {
            Effect: "Allow",
            Principal: {
              AWS: `arn:${partition}:iam::${identity.accountId}:root`,
            },
            Action: "sts:AssumeRole",
          },
        ];
        return JSON.stringify(parsed);
      }),
  });
}

/**
 * A transform's result that changes only the properties. Without `opts`,
 * Pulumi keeps the resource's options as they are; options given back are
 * rebuilt from the part of them a transform sees, which leaves some out.
 */
function propsOnly(props: pulumi.Inputs): pulumi.ResourceTransformResult {
  return { props } as pulumi.ResourceTransformResult;
}
