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

  const fnHost = "abcdefghijklmnopqrstuvwxyz234567.lambda-url.us-east-1.on.aws";

  it.each(["oac", "oac-with-edge-signing"] as const)(
    "signs a Lambda function URL route that sets protection under %s",
    async (protection) => {
      const router = createRouter(protection);

      router.route("/api", `https://${fnHost}`, { protection: true });
      await settle(fnHost);

      expect(getOrigin(fnHost).originAccessControlConfig).toEqual({
        enabled: true,
        signingBehavior: "always",
        signingProtocol: "sigv4",
        originType: "lambda",
      });
    },
  );

  it("signs the route when protection is an Output", async () => {
    const router = createRouter("oac");

    router.route("/api", `https://${fnHost}`, {
      protection: pulumi.output(true),
    });
    await settle(fnHost);

    expect(getOrigin(fnHost).originAccessControlConfig).toBeDefined();
  });

  it("forces HTTPS for a signed Lambda function URL route", async () => {
    const router = createRouter("oac");

    router.route("/api", `http://${fnHost}`, { protection: true });
    await settle(fnHost);

    const origin = getOrigin(fnHost);
    expect(origin.originAccessControlConfig).toBeDefined();
    expect(origin.protocol).toBeUndefined();
  });

  it.each(["oac", "oac-with-edge-signing"] as const)(
    "leaves a route unsigned by default under %s",
    async (protection) => {
      const router = createRouter(protection);

      router.route("/api", `https://${fnHost}`);
      await settle(fnHost);

      expect(getOrigin(fnHost).originAccessControlConfig).toBeUndefined();
    },
  );

  it("leaves a route unsigned when other route args are set", async () => {
    const router = createRouter("oac");

    router.route("/api", `https://${fnHost}`, { connectionAttempts: 2 });
    await settle(fnHost);

    expect(getOrigin(fnHost).originAccessControlConfig).toBeUndefined();
  });

  it("leaves a route unsigned when protection is false", async () => {
    const router = createRouter("oac");

    router.route("/api", `https://${fnHost}`, { protection: false });
    await settle(fnHost);

    expect(getOrigin(fnHost).originAccessControlConfig).toBeUndefined();
  });

  it("keeps an http:// function URL as http:// when the route is not signed", async () => {
    const router = createRouter("oac");

    router.route("/api", `http://${fnHost}`);
    await settle(fnHost);

    expect(getOrigin(fnHost).protocol).toBe("http");
  });

  it("does not sign when the Router has no protection", async () => {
    const router = createRouter("none");

    router.route("/api", `https://${fnHost}`, { protection: true });
    await settle(fnHost);

    expect(getOrigin(fnHost).originAccessControlConfig).toBeUndefined();
  });

  it("does not sign an ordinary HTTPS origin", async () => {
    const router = createRouter("oac");
    const host = "api.example.com";

    router.route("/api", `https://${host}`, { protection: true });
    await settle(host);

    expect(getOrigin(host).originAccessControlConfig).toBeUndefined();
  });

  it.each([
    "abcdefghijklmnopqrstuvwxyz.lambda-url.us-east-1.on.aws",
    "abcdefghijklmnopqrstuvwxyz234567.lambda-url.us-east-1.on.aws.example.com",
  ])("does not sign the look-alike hostname %s", async (host) => {
    const router = createRouter("oac");

    router.route("/api", `https://${host}`, { protection: true });
    await settle(host);

    expect(getOrigin(host).originAccessControlConfig).toBeUndefined();
  });
});
