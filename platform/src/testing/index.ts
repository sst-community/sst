import fs from "fs";
import * as pulumi from "@pulumi/pulumi";
import { type MockInput, mockPulumi } from "./mock";

export type { MockInput, RecordedResource } from "./mock";

/**
 * Test a component without deploying it. `mock()` stands in for the engine
 * that deploys your app and gives your test what your `sst.config.ts` has:
 * `sst`, your providers like `aws`, `$app`, `$dev` and the other `$` globals.
 *
 * Nothing is deployed and no provider is called. Each resource your component
 * creates is recorded, with the inputs and options it was given, and comes
 * back with an id and an ARN made from its name.
 *
 * Call it before the file that defines your component is loaded, as that
 * file reads `sst` and `aws` when it loads.
 *
 * @example
 * ```ts title="uploads.test.ts"
 * import { expect, test } from "vitest";
 * import { mock } from "./.sst/platform/src/testing";
 *
 * const app = await mock();
 * const { Uploads } = await import("./infra/uploads");
 *
 * test("creates a role for each team", async () => {
 *   app.reset();
 *   new Uploads("Docs", { teams: ["design", "legal"] });
 *   await app.settle();
 *
 *   expect(app.resources.map((r) => r.name)).toContain("DocsReaderLegal");
 * });
 * ```
 */
export async function mock(input?: MockInput & { dev?: boolean }) {
  const engine = mockPulumi({ root: process.cwd(), ...input });

  // What `sst.config.ts` is given when it's built: the app, and whether this
  // is `sst dev`
  Object.assign(globalThis, {
    $app: {
      name: input?.app ?? "app",
      stage: input?.stage ?? "test",
      removal: "remove",
      providers: {},
      protect: false,
    },
    $dev: input?.dev ?? false,
  });

  // The rest of the `$` globals. These are what `shim/run.js` gives a config.
  const { Link } = await import("../components/link");
  const { $asset, $transform } = await import("../components/component");
  const { $config } = await import("../config");
  Object.assign(globalThis, {
    $linkable: Link.linkable,
    $output: pulumi.output,
    $apply: (pulumi as any).apply,
    $resolve: pulumi.all,
    $interpolate: pulumi.interpolate,
    $concat: pulumi.concat,
    $jsonParse: pulumi.jsonParse,
    $jsonStringify: pulumi.jsonStringify,
    $util: pulumi,
    $asset,
    $config,
    $transform,
    $secrets: {},
  });

  // Each provider under its name, and the components as `sst`
  for (const provider of providers())
    (globalThis as any)[provider.alias] = await import(provider.package);
  (globalThis as any).sst = await import("../components/index");

  return engine;
}

// The providers of the app, as `sst install` wrote them next to the platform.
// Where there is no app, as in the platform's own tests, the ones the
// platform comes with.
function providers(): { alias: string; package: string }[] {
  try {
    return JSON.parse(
      fs.readFileSync(
        new URL("../../../provider-lock.json", import.meta.url),
        "utf8",
      ),
    );
  } catch {
    return [
      { alias: "aws", package: "@pulumi/aws" },
      { alias: "cloudflare", package: "@pulumi/cloudflare" },
    ];
  }
}
