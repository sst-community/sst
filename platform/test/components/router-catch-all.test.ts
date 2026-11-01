import { describe, beforeAll, beforeEach, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
global.$util = pulumi;

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs): {
      id: string;
      state: any;
    } {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: args.inputs.name + "_id",
        state: {
          ...args.inputs,
          arn: `arn:aws:mock:us-east-1:account:${args.name}`,
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

const TYPES = {
  cfFunction: "aws:cloudfront/function:Function",
  cfDistribution: "aws:cloudfront/distribution:Distribution",
};

function findResources(type: string) {
  return createdResources.filter((r) => r.type === type);
}

// Flush event loop to let Pulumi .apply() chains settle without wall-clock delays
async function settle() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Runs the code of a generated CloudFront function with a fake viewer-request event
// and returns what the function returns: the request when it lets it through, or a
// response when it answers at the edge.
async function runFunction(code: string, uri: string) {
  const event = {
    request: {
      method: "GET",
      uri,
      querystring: {},
      headers: { host: { value: "router.example.com" } },
      cookies: {},
    },
  };
  const handler = new Function(`${code}\nreturn handler;`)() as (
    event: unknown,
  ) => Promise<any>;
  return handler(event);
}

// The functions that answer with a response instead of passing the request on.
async function functionsThatAnswer(uri = "/nothing/here") {
  const answering: { name: string; response: any }[] = [];
  for (const fn of findResources(TYPES.cfFunction)) {
    const result = await runFunction(fn.inputs.code as string, uri).catch(
      () => undefined,
    );
    if (result && typeof result.statusCode === "number") {
      answering.push({ name: fn.name, response: result });
    }
  }
  return answering;
}

describe("Router catch-all route", function () {
  let Router: typeof import("./../../src/components/aws/router").Router;

  beforeAll(async function () {
    Router = (await import("./../../src/components/aws/router")).Router;
  });

  beforeEach(function () {
    createdResources = [];
  });

  it("returns 404 at the edge when no /* route is defined", async () => {
    new Router("NoCatchAll", {
      routes: { "/api/*": "https://example.com" },
    });
    await settle();

    const answering = await functionsThatAnswer("/nothing/here");
    expect(answering).toHaveLength(1);
    const { response } = answering[0];
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"].value).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.body.data).toContain("404 Not Found");
  });

  it("attaches the 404 function to the default cache behavior", async () => {
    new Router("DefaultBehavior", {
      routes: { "/api/*": "https://example.com" },
    });
    await settle();

    // The function whose code answers with the 404 ...
    const notFound = await functionsThatAnswer("/nothing/here");
    expect(notFound).toHaveLength(1);

    // ... is the viewer-request function of the distribution's default behavior,
    // which is the one that handles a path no route matches.
    const [distribution] = findResources(TYPES.cfDistribution);
    const associations = await new Promise<any[]>((resolve) =>
      pulumi
        .output(distribution.inputs.defaultCacheBehavior)
        .apply((behavior: any) =>
          resolve(behavior.functionAssociations as any[]),
        ),
    );
    const viewerRequests = associations.filter(
      (a) => a.eventType === "viewer-request",
    );
    expect(viewerRequests).toHaveLength(1);
    expect(String(viewerRequests[0].functionArn)).toContain(notFound[0].name);
  });

  it("does not answer with a 404 when a /* route is defined", async () => {
    new Router("WithCatchAll", {
      routes: {
        "/api/*": "https://example.com",
        "/*": "https://example.org",
      },
    });
    await settle();

    expect(await functionsThatAnswer("/nothing/here")).toHaveLength(0);
  });
});
