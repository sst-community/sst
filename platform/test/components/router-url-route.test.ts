import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import type { Router as RouterType } from "../../src/components/aws/router";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

const captured = vi.hoisted(() => ({ routeMetadata: [] as unknown[] }));

vi.mock("../../src/components/aws/router-base-route", () => ({
  buildKvNamespace: () => "route",
  parsePattern: () => ({ host: "", path: "/api" }),
  createKvRouteData: (
    _name: unknown,
    _args: unknown,
    _parent: unknown,
    _namespace: unknown,
    metadata: unknown,
  ) => {
    captured.routeMetadata.push(metadata);
  },
  updateKvRoutes: () => undefined,
}));

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
global.$util = pulumi;

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      return {
        id: `${args.name}_id`,
        state: args.inputs,
      };
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

async function settle(host: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = captured.routeMetadata.some(
      (m) =>
        !!m && typeof m === "object" && (m as { host?: unknown }).host === host,
    );
    if (found) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error(`Route metadata was not captured for ${host}`);
}

function getOrigin(host: string): Record<string, unknown> {
  for (const metadata of captured.routeMetadata) {
    const parsed = metadata;

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("host" in parsed) ||
      parsed.host !== host ||
      !("origin" in parsed) ||
      !parsed.origin ||
      typeof parsed.origin !== "object"
    )
      continue;

    return parsed.origin as Record<string, unknown>;
  }

  throw new Error(`Route metadata not found for ${host}`);
}

describe("Router URL route protection", () => {
  let Router: typeof RouterType;

  beforeAll(async () => {
    // Import after installing Pulumi globals and mocks used during module setup.
    Router = (await import("../../src/components/aws/router")).Router;
  });

  function createRouter(protection: "none" | "oac" | "oac-with-edge-signing") {
    // Bypass unrelated Router infrastructure so this exercises only route propagation.
    const router = Object.create(Router.prototype) as RouterType;
    Object.assign(router, {
      constructorName: `Router-${protection}`,
      constructorOpts: {},
      kvStoreArn: pulumi.output(
        "arn:aws:cloudfront::account:key-value-store/test",
      ),
      kvNamespace: pulumi.output("router"),
      hasInlineRoutes: pulumi.output(false),
      _protectionMode: pulumi.output({ mode: protection }),
    });
    return router;
  }

  beforeEach(() => {
    captured.routeMetadata.length = 0;
  });

  it.each(["oac", "oac-with-edge-signing"] as const)(
    "applies %s protection to Lambda function URLs",
    async (protection) => {
      const router = createRouter(protection);
      const host =
        "abcdefghijklmnopqrstuvwxyz234567.lambda-url.us-east-1.on.aws";

      router.route("/api", `https://${host}`);
      await settle(host);

      expect(getOrigin(host).originAccessControlConfig).toEqual({
        enabled: true,
        signingBehavior: "always",
        signingProtocol: "sigv4",
        originType: "lambda",
      });
    },
  );

  it("forces HTTPS for protected Lambda function URLs", async () => {
    const router = createRouter("oac");
    const host = "abcdefghijklmnopqrstuvwxyz234567.lambda-url.us-east-1.on.aws";

    router.route("/api", `http://${host}`);
    await settle(host);

    const origin = getOrigin(host);
    expect(origin.originAccessControlConfig).toBeDefined();
    expect(origin.protocol).toBeUndefined();
  });

  it("does not apply OAC for the normalized default protection mode", async () => {
    const router = createRouter("none");
    const host = "abcdefghijklmnopqrstuvwxyz234567.lambda-url.us-east-1.on.aws";

    router.route("/api", `https://${host}`);
    await settle(host);

    expect(getOrigin(host).originAccessControlConfig).toBeUndefined();
  });

  it("does not apply OAC to ordinary HTTPS origins", async () => {
    const router = createRouter("oac");
    const host = "api.example.com";

    router.route("/api", `https://${host}`);
    await settle(host);

    expect(getOrigin(host).originAccessControlConfig).toBeUndefined();
  });

  it.each([
    "abcdefghijklmnopqrstuvwxyz.lambda-url.us-east-1.on.aws",
    "abcdefghijklmnopqrstuvwxyz234567.lambda-url.us-east-1.on.aws.example.com",
  ])("does not apply OAC to spoofed Lambda URL hostname %s", async (host) => {
    const router = createRouter("oac");

    router.route("/api", `https://${host}`);
    await settle(host);

    expect(getOrigin(host).originAccessControlConfig).toBeUndefined();
  });
});
