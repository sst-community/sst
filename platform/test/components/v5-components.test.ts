import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

mockPulumi();

// Every V5 component: a file in `aws/v5/`, named like the file of the
// component it replaces. Its docs page and sidebar entry are found there too.
// What's still written by hand for each one is checked here.
const dir = new URL("../../src/components/aws/v5/", import.meta.url);
const files = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts");

// The 5.0 rewrite makes a clean break from 4.x code. These are built the 5.0
// way; the others still lean on 4.x until each is rebuilt.
const rebuilt = [
  "vpc.ts",
  "function.ts",
  "router.ts",
  "nextjs.ts",
  "cdn.ts",
  "dns-validated-certificate.ts",
  "https-redirect.ts",
  "bucket.ts",
  "queue.ts",
  "sns-topic.ts",
  "dynamo.ts",
  "bus.ts",
  "cron-v2.ts",
  "cluster.ts",
  "task.ts",
  "efs.ts",
  "redis.ts",
  "postgres.ts",
  "mysql.ts",
  "aurora.ts",
  "dsql.ts",
  "apigatewayv2.ts",
  "app-sync.ts",
  "cognito-user-pool.ts",
  "cognito-user-pool-client.ts",
  "email.ts",
  "alb.ts",
  "service.ts",
  "astro.ts",
  "svelte-kit.ts",
  "static-site.ts",
  "tan-stack-start.ts",
  "nuxt.ts",
  "solid-start.ts",
  "analog.ts",
  "remix.ts",
  "react.ts",
  "step-functions.ts",
  "cron.ts",
  "cognito-identity-pool.ts",
  "auth.ts",
  "realtime.ts",
  "workflow.ts",
  "apigateway-websocket.ts",
  "apigatewayv1.ts",
  "apigatewayv1-usage-plan.ts",
  "apigatewayv1-api-key.ts",
  "microvm.ts",
  "vector.ts",
];

describe("V5 components", () => {
  let takeoverOf: typeof import("../../src/components/takeover").takeoverOf;

  beforeAll(async () => {
    ({ takeoverOf } = await import("../../src/components/takeover"));
    await import("../../src/components/aws/takeover/index");
  });

  it("are found", () => {
    expect(files).toContain("queue.ts");
  });

  it("are exported as sst.aws.v5", () => {
    const index = fs.readFileSync(new URL("../index.ts", dir), "utf8");
    expect(index).toContain(`export * as v5 from "./v5/index.js";`);
  });

  describe.each(files)("%s", (file) => {
    const name = file.slice(0, -3);
    let component: any;

    beforeAll(async () => {
      const module = await import(`../../src/components/aws/v5/${name}.ts`);
      component = Object.values(module).find(
        (value: any) => typeof value?.__pulumiType === "string",
      );
    });

    // A deployed component becomes the V5 one when the name is kept, because
    // the two have the same type. The class is named the same, and so is the
    // file.
    it("has the name and type of the component it replaces", async () => {
      // 4.x spelled the `Cdn`'s type in capitals and TanStack Start's with a
      // small "s", and named the certificate's type for what it is, and a
      // deployed one keeps each
      const typeName =
        {
          Cdn: "CDN",
          DnsValidatedCertificate: "Certificate",
          TanStackStart: "TanstackStart",
        }[component.name as string] ?? component.name;
      expect(component.__pulumiType).toBe(`sst:aws:${typeName}`);
      const original = await import(`../../src/components/aws/${name}.ts`);
      expect(
        original[component.name]?.__pulumiType,
        `aws/${file} has to export the ${component.name} this one replaces`,
      ).toBe(component.__pulumiType);
    });

    // A part that has another name, or another place, than it had in the
    // component it replaces is in a map in `aws/takeover/`, imported from its
    // `index.ts`.
    // The map is how the CLI knows a type's 4.x form has this 5.0 form:
    // without one, a new stage takes the 4.x form, and a plain deploy can
    // switch it, where only `sst migrate` releases what a switch releases.
    it("has a takeover map, even an empty one", () => {
      expect(
        takeoverOf(component),
        `Add aws/takeover/${file}, with "takeover(${component.name}, {})" when nothing moved, and import it from aws/takeover/index.ts`,
      ).toBeDefined();
    });

    it("has its takeover map loaded, when it has one", () => {
      if (!fs.existsSync(new URL(`../takeover/${file}`, dir))) return;
      expect(
        takeoverOf(component),
        `Import aws/takeover/${file} from aws/takeover/index.ts`,
      ).toBeDefined();
    });

    it("is exported from sst.aws.v5", () => {
      const index = fs.readFileSync(new URL("index.ts", dir), "utf8");
      const line = `export * from "./${file.slice(0, -3)}";`;
      expect(index, `Add \`${line}\` to aws/v5/index.ts`).toContain(line);
    });

    // What came before belongs in the takeover map. The component's code
    // names no other component's type and sets no aliases. (`aliases` as an
    // arg of the component, like Cognito's sign-in aliases, is fine.)
    it("leaves what came before to its takeover map", () => {
      const code = fs
        .readFileSync(new URL(file, dir), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      const otherTypes = (code.match(/sst:\w+:[A-Z]\w+/g) ?? []).filter(
        (found) => found !== component.__pulumiType,
      );
      expect(otherTypes).toEqual([]);
      expect(code).not.toMatch(/takeover|\baliases\s*:/);
    });

    // Its args, types and docs are its own. A 4.x component it takes, like a
    // `Vpc` or a `Router`, is reached through a helper that takes either kind
    // (`helpers/vpc.ts`), until 5.0 has no 4.x components: those are the only
    // 4.x files it reaches, through any of the helpers it uses. The modules
    // that aren't components, like `permission.ts` or the providers, are
    // shared.
    it("reaches no 4.x component's file, once it's built the 5.0 way", () => {
      if (!rebuilt.includes(file)) return;
      expect(fourXReached(new URL(file, dir))).toEqual([]);
    });
  });
});

// The helpers that take either kind of a component, and the 4.x file each
// imports for it. A V5 component reaches 4.x's code through these alone.
const eitherKind: Record<string, string[]> = {
  "aws/helpers/vpc.ts": ["aws/vpc.ts"],
  "aws/helpers/efs.ts": ["aws/efs.ts"],
  "aws/helpers/bucket.ts": ["aws/bucket.ts"],
  "aws/helpers/queue.ts": ["aws/queue.ts"],
  "aws/helpers/sns-topic.ts": ["aws/sns-topic.ts"],
  "aws/helpers/bus.ts": ["aws/bus.ts"],
  "aws/helpers/task.ts": ["aws/task.ts"],
  "aws/helpers/router.ts": ["aws/router.ts"],
  // A load balancer a service shares
  "aws/helpers/alb.ts": ["aws/alb.ts"],
  // A task's or a service's cluster, and a file system it mounts
  "aws/helpers/fargate.ts": ["aws/cluster.ts", "aws/efs.ts"],
  // A function given as either \`Function\`, or either \`Workflow\`
  "aws/helpers/function-part.ts": ["aws/function.ts", "aws/workflow.ts"],
  // The states the 4.x and V5 \`StepFunctions\` share. They take the 4.x
  // \`Function\`'s permission type, and \`task.ts\` the 4.x components the 4.x
  // one's integrations take, types only. The V5 one's integrations are its
  // own. When the 4.x components go, these imports go with them.
  "aws/step-functions/state.ts": ["aws/function.ts"],
  "aws/step-functions/map.ts": ["aws/function.ts"],
  "aws/step-functions/task.ts": [
    "aws/function.ts",
    "aws/sns-topic.ts",
    "aws/queue.ts",
    "aws/task.ts",
    "aws/bus.ts",
  ],
};

// The 4.x component files a file reaches: those it imports, and those the
// helpers it imports reach, but what a helper imports to take either kind
function fourXReached(start: typeof dir) {
  const reached = new Set<string>();
  const seen = new Set<string>();
  const walk = (file: typeof dir) => {
    const name = fileURLToPath(file).split("/src/components/")[1];
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(
      /(?:\bfrom|^\s*import)\s*["'](\.[^"']+)["']/gm,
    )) {
      const target = new URL(`${match[1].replace(/\.js$/, "")}.ts`, file);
      // Outside the components, like \`util/\`, isn't a component's
      const targetName = fileURLToPath(target).split("/src/components/")[1];
      if (!targetName || !fs.existsSync(target)) continue;
      if (seen.has(`${name}>${targetName}`)) continue;
      seen.add(`${name}>${targetName}`);
      const isFourX = /\bclass \w+ extends Component\b/.test(
        fs.readFileSync(target, "utf8"),
      );
      if (isFourX) {
        if (!eitherKind[name]?.includes(targetName))
          reached.add(`${targetName}, through ${name}`);
      } else if (
        targetName.startsWith("aws/helpers/") ||
        targetName.startsWith("aws/step-functions/")
      )
        walk(target);
    }
  };
  walk(start);
  return [...reached].sort();
}

// The CLI bundles a config with esbuild, and this package says its files have
// no side effects. A file that's imported for what it does, not for what it
// exports, is then left out of the bundle: the takeover maps are such files,
// and without them a switch deletes and recreates everything that moved. No
// test under the mock can see that, because nothing is bundled there.
describe("a config the CLI builds", () => {
  it("has every takeover map in it", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
      stdin: {
        contents: `import * as sst from "./src/components/index.ts"; globalThis.sst = sst;`,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "ts",
      },
      // As in `pkg/js/js.go`
      bundle: true,
      format: "esm",
      platform: "node",
      mainFields: ["module", "main"],
      external: [
        "@pulumi/*",
        "undici",
        "@pulumiverse/*",
        "@sst-provider/*",
        "@aws-sdk/*",
        "esbuild",
        "archiver",
        "glob",
        "vite",
      ],
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const [output] = Object.values(result.metafile.outputs);
    const bundled = Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => path);

    const maps = fs
      .readdirSync(new URL("../takeover/", dir))
      .filter((file) => !["index.ts", "helpers.ts"].includes(file));
    expect(maps).toContain("queue.ts");
    for (const map of maps)
      expect(
        bundled,
        `aws/takeover/${map} isn't in a built config. "sideEffects" in package.json has to list the takeover maps.`,
      ).toContain(`src/components/aws/takeover/${map}`);
  });
});
