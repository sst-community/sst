import { beforeAll, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { Provider } from "@pulumi/aws";

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;
const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push(args);
      return {
        id: `${args.name}_id`,
        state: {
          ...args.inputs,
          arn: `arn:aws:apigateway:us-east-1::/apis/${args.name}`,
          executionArn: `arn:aws:execute-api:us-east-1:123456789012:${args.name}`,
          apiEndpoint: `https://${args.name}.execute-api.us-east-1.amazonaws.com`,
          rootResourceId: "root",
        },
      };
    },
    call: (args) => args.inputs,
  },
  "project",
  "stack",
  true,
);
const arn = "arn:aws:lambda:us-east-1:123456789012:function:shared";
const value = <T>(out: pulumi.Output<T>) =>
  new Promise<T>((resolve) => out.apply(resolve));
const permissions = (prefix: string) =>
  resources.filter(
    (r) =>
      r.type === "aws:lambda/permission:Permission" &&
      r.name.startsWith(prefix),
  );

let types: any[];
beforeAll(async () => {
  types = [
    (await import("../../src/components/aws/apigatewayv2")).ApiGatewayV2,
    (await import("../../src/components/aws/apigatewayv1")).ApiGatewayV1,
    (await import("../../src/components/aws/apigateway-websocket"))
      .ApiGatewayWebSocket,
  ];
});
for (const [index, kind] of ["Http", "Rest", "WebSocket"].entries()) {
  describe(kind, () => {
    it("uses one eager permission for many routes and preserves the alias", async () => {
      const prefix = `${kind}Shared`;
      const api = new types[index](prefix);
      const handler = api.addHandler("Backend", pulumi.output(`${arn}:live`));
      const routes = Array.from({ length: 60 }, (_, i) =>
        api.route(index === 2 ? `route${i}` : `GET /route${i}`, handler),
      );
      await Promise.all(routes.map((r) => value(r.nodes.integration.id)));
      expect(permissions(prefix)).toHaveLength(1);
      expect(permissions(prefix)[0].inputs).toMatchObject({
        function: arn,
        qualifier: "live",
        action: "lambda:InvokeFunction",
        principal: "apigateway.amazonaws.com",
        sourceArn: `arn:aws:execute-api:us-east-1:123456789012:${prefix}Api/*`,
      });
      expect(
        routes.every((r) => r.nodes.permission === routes[0].nodes.permission),
      ).toBe(true);
      const integrations = resources.filter(
        (r) =>
          r.name.startsWith(prefix) &&
          r.type.endsWith("/integration:Integration"),
      );
      expect(integrations).toHaveLength(60);
      for (const integration of integrations) {
        expect(
          integration.inputs.integrationUri ?? integration.inputs.uri,
        ).toContain(`${arn}:live`);
      }
    });
    it("inherits the API provider and keeps the grant without routes", async () => {
      const prefix = `${kind}Provider`;
      const provider = new Provider(`${prefix}Aws`, { region: "us-east-1" });
      const api = new types[index](prefix, {}, { provider });
      const handler = api.addHandler("Backend", arn);
      await value(handler.permission.urn);
      expect(permissions(prefix)).toHaveLength(1);
      expect(
        handler.permission.getProvider("aws:lambda/permission:Permission"),
      ).toBe(provider);
      const route = api.route(index === 2 ? "a" : "GET /a", handler);
      await value(route.nodes.integration.id);
      expect(route.nodes.permission).toBe(handler.permission);
      expect(
        route.nodes.integration.getProvider("aws:lambda/permission:Permission"),
      ).toBe(provider);
      expect(permissions(prefix)).toHaveLength(1);
    });

    it("keeps per-route grants by default", async () => {
      const prefix = `${kind}Default`;
      const api = new types[index](prefix);
      const routes = ["a", "b"].map((p) =>
        api.route(index === 2 ? p : `GET /${p}`, arn),
      );
      await Promise.all(routes.map((r) => value(r.nodes.integration.id)));
      expect(permissions(prefix)).toHaveLength(2);
    });
    it("rejects a binding from another API and duplicate binding names", () => {
      const api = new types[index](`${kind}Owner`);
      const other = new types[index](`${kind}Other`);
      const handler = api.addHandler("Backend", arn);
      expect(() => other.route(index === 2 ? "a" : "GET /a", handler)).toThrow(
        /different API/,
      );
      expect(() => api.addHandler("Backend", `${arn}:other`)).toThrow(
        /already exists/,
      );
    });
    it("registers a named permission even when its ARN is unknown during preview", async () => {
      const prefix = `${kind}Unknown`;
      const api = new types[index](prefix);
      const handler = api.addHandler(
        "Backend",
        pulumi.output(pulumi.unknown as any),
      );
      const route = api.route(index === 2 ? "a" : "GET /a", handler);
      await value(route.nodes.permission.urn);
      expect(permissions(prefix)).toHaveLength(1);
    });
    it("keeps separate grants for distinct qualifiers and APIs", async () => {
      const prefix = `${kind}Separate`;
      const apis = [
        new types[index](`${prefix}One`),
        new types[index](`${prefix}Two`),
      ];
      const routes = apis.flatMap((api) =>
        ["live", "next"].map((alias) => {
          const handler = api.addHandler(alias, `${arn}:${alias}`);
          return api.route(index === 2 ? alias : `GET /${alias}`, handler);
        }),
      );
      await Promise.all(routes.map((r) => value(r.nodes.integration.id)));
      expect(permissions(prefix)).toHaveLength(4);
      expect(
        permissions(prefix)
          .map((r) => r.inputs.qualifier)
          .sort(),
      ).toEqual(["live", "live", "next", "next"]);
    });
  });
}

it("accepts a Function ARN exposed as Output<string> for every API", async () => {
  const { ApiGatewayV2 } = await import(
    "../../src/components/aws/apigatewayv2"
  );
  const { ApiGatewayV1 } = await import(
    "../../src/components/aws/apigatewayv1"
  );
  const { ApiGatewayWebSocket } = await import(
    "../../src/components/aws/apigateway-websocket"
  );
  const apis = [
    new ApiGatewayV2("TypedHttp"),
    new ApiGatewayV1("TypedRest"),
    new ApiGatewayWebSocket("TypedSocket"),
  ];
  const functionArn: pulumi.Output<string> = pulumi.output(arn);
  for (const api of apis) {
    const binding = api.addHandler("Backend", functionArn);
    expect(await value(binding.arn)).toBe(arn);
  }
});
