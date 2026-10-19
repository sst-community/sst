import { beforeEach, describe, expect, it } from "vitest";
import { mock } from "sst/testing";

const app = await mock();
const { Saas } = await import("../src/index");
const { v5 } = await import("sst/components/aws");

const find = (name: string) => app.resources.find((r) => r.name === name);
const ofType = (type: string) => app.resources.filter((r) => r.type === type);
const configOf = (fn: string) =>
  JSON.parse(find(fn)!.inputs.environment.variables.SAAS_CONFIG);
// What the CLI builds a function from: only the graph has it
const buildOf = (name: string) =>
  app.graph().find((r) => r.name === name)?.build;

describe("Saas", () => {
  beforeEach(() => app.reset());

  it("creates a user pool, a client, an API, three tables and three functions", async () => {
    new Saas("App");
    await app.settle();

    const components = app.resources
      .filter((r) => !r.custom && r.parent.endsWith("::App"))
      .map((r) => `${r.type} ${r.name}`)
      .sort();
    expect(components).toEqual([
      "sst:aws:ApiGatewayV2 AppApi",
      "sst:aws:CognitoUserPool AppUserPool",
      "sst:aws:CognitoUserPoolClient AppClientWeb",
      "sst:aws:Dynamo AppMemberships",
      "sst:aws:Dynamo AppTenants",
      "sst:aws:Dynamo AppUsers",
      "sst:aws:Function AppApiFunction",
      "sst:aws:Function AppPostConfirmation",
      "sst:aws:Function AppPreTokenGeneration",
    ]);
  });

  it("signs in by email, with both triggers, on a tier that customizes access tokens", async () => {
    new Saas("App");
    await app.settle();

    const pool = ofType("aws:cognito/userPool:UserPool")[0].inputs;
    expect(pool.usernameAttributes).toEqual(["email"]);
    expect(pool.userPoolTier).toBe("ESSENTIALS");
    expect(pool.lambdaConfig.postConfirmation).toContain("AppPostConfirmation");
    expect(pool.lambdaConfig.preTokenGenerationConfig).toMatchObject({
      lambdaVersion: "V2_0",
    });
    expect(pool.lambdaConfig.preTokenGenerationConfig.lambdaArn).toContain(
      "AppPreTokenGeneration",
    );
    // The user pool may invoke them
    expect(
      ofType("aws:lambda/permission:Permission").map((r) => r.inputs.principal),
    ).toEqual(expect.arrayContaining(["cognito-idp.amazonaws.com"]));
  });

  it("sends every route to one function, behind a JWT authorizer for the user pool", async () => {
    new Saas("App");
    await app.settle();

    const routes = ofType("aws:apigatewayv2/route:Route")
      .map((r) => [
        r.inputs.routeKey,
        r.inputs.authorizationType,
        r.inputs.authorizationScopes,
      ])
      .sort();
    expect(routes).toEqual([
      ["ANY /admin/{proxy+}", "JWT", ["platform/admin"]],
      ["ANY /{proxy+}", "JWT", undefined],
    ]);
    const integrations = ofType("aws:apigatewayv2/integration:Integration");
    expect(integrations).toHaveLength(2);
    for (const integration of integrations)
      expect(integration.inputs.integrationUri).toContain("AppApiFunction");

    const authorizer = ofType("aws:apigatewayv2/authorizer:Authorizer")[0]
      .inputs;
    expect(authorizer.authorizerType).toBe("JWT");
    expect(authorizer.jwtConfiguration.issuer).toMatch(
      /^https:\/\/cognito-idp\.[^.]+\.amazonaws\.com\//,
    );
    expect(authorizer.jwtConfiguration.audiences).toHaveLength(1);
  });

  it("tells its functions where the tables are, and links them", async () => {
    new Saas("App");
    await app.settle();

    for (const fn of [
      "AppApiFunction",
      "AppPostConfirmation",
      "AppPreTokenGeneration",
    ]) {
      const config = configOf(`${fn}Function`);
      expect(config.store.type).toBe("dynamo");
      expect(Object.keys(config.store.tables)).toEqual([
        "users",
        "tenants",
        "memberships",
      ]);
      expect(config).toMatchObject({
        ownerRole: "owner",
        defaultRole: "member",
        personal: true,
        selfServe: true,
        path: "",
        disabled: [],
      });
      expect(Object.keys(buildOf(fn)!.links).sort()).toEqual([
        "AppMemberships",
        "AppTenants",
        "AppUsers",
      ]);
    }
    expect(buildOf("AppApiFunction")!.handler).toMatch(/dist\/handlers\.api$/);
  });

  it("keys the tables for the store", async () => {
    new Saas("App");
    await app.settle();

    const tables = Object.fromEntries(
      ofType("aws:dynamodb/table:Table").map((r) => [r.name, r.inputs]),
    );
    expect(tables.AppUsersTable).toMatchObject({
      hashKey: "id",
      globalSecondaryIndexes: [
        expect.objectContaining({ name: "byEmail", hashKey: "email" }),
      ],
    });
    expect(tables.AppTenantsTable).toMatchObject({ hashKey: "id" });
    expect(tables.AppMembershipsTable).toMatchObject({
      hashKey: "tenantId",
      rangeKey: "userId",
      globalSecondaryIndexes: [
        expect.objectContaining({
          name: "byUser",
          hashKey: "userId",
          rangeKey: "tenantId",
        }),
      ],
    });
  });

  it("takes roles, tenant settings, a path and routes to turn off", async () => {
    new Saas("App", {
      roles: { boss: ["*"], viewer: ["tenant:read"] },
      ownerRole: "boss",
      defaultRole: "viewer",
      tenants: { personal: false, selfServe: false },
      path: "/saas/",
      routes: { "DELETE /tenant": false },
    });
    await app.settle();

    expect(configOf("AppApiFunctionFunction")).toMatchObject({
      roles: { boss: ["*"], viewer: ["tenant:read"] },
      ownerRole: "boss",
      defaultRole: "viewer",
      personal: false,
      selfServe: false,
      path: "/saas",
      disabled: ["DELETE /tenant"],
    });
    expect(
      ofType("aws:apigatewayv2/route:Route")
        .map((r) => r.inputs.routeKey)
        .sort(),
    ).toEqual(["ANY /saas/admin/{proxy+}", "ANY /saas/{proxy+}"]);
  });

  it("checks its roles", () => {
    expect(() => new Saas("App", { roles: { boss: ["*"] } })).toThrow(
      `"ownerRole" is "owner", which isn't one of the roles: boss.`,
    );
    expect(
      () =>
        new Saas("App", {
          roles: { owner: ["*"], Member: [] },
          defaultRole: "Member",
        }),
    ).toThrow(`The role "Member" can only have lowercase letters`);
    expect(
      () => new Saas("App", { roles: { owner: ["a b"], member: [] } }),
    ).toThrow(`The permission "a b" of the role "owner"`);
    expect(
      () => new Saas("App", { routes: { "GET /nope": false } as any }),
    ).toThrow(`has no route "GET /nope"`);
  });

  it("runs the functions from a file of the app's", async () => {
    new Saas("App", { handlers: "src/saas.ts" });
    await app.settle();
    expect(buildOf("AppApiFunction")!.handler).toBe("src/saas.api");
    expect(buildOf("AppPostConfirmation")!.handler).toBe(
      "src/saas.postConfirmation",
    );
    expect(buildOf("AppPreTokenGeneration")!.handler).toBe(
      "src/saas.preTokenGeneration",
    );
  });

  it("creates no tables for custom storage, and needs handlers for it", async () => {
    expect(() => new Saas("App", { storage: "custom" })).toThrow(
      `needs "handlers"`,
    );
    await app.settle();
    app.reset();

    const db = new v5.Dynamo("Db", {
      fields: { pk: "string" },
      primaryIndex: { hashKey: "pk" },
    });
    new Saas("App", { storage: "custom", handlers: "src/saas.ts", link: [db] });
    await app.settle();

    expect(ofType("aws:dynamodb/table:Table").map((r) => r.name)).toEqual([
      "DbTable",
    ]);
    expect(configOf("AppApiFunctionFunction").store).toEqual({
      type: "custom",
    });
    expect(Object.keys(buildOf("AppApiFunction")!.links)).toEqual(["Db"]);
  });

  it("puts its routes on an API that's passed in, under a path", async () => {
    expect(
      () =>
        new Saas("App", { existing: { api: new v5.ApiGatewayV2("Other") } }),
    ).toThrow(`needs a "path"`);
    await app.settle();
    app.reset();

    const api = new v5.ApiGatewayV2("Mine");
    api.route("GET /health", "src/health.handler");
    new Saas("App", { existing: { api }, path: "/saas" });
    await app.settle();

    expect(ofType("sst:aws:ApiGatewayV2").map((r) => r.name)).toEqual(["Mine"]);
    expect(
      ofType("aws:apigatewayv2/route:Route")
        .map((r) => r.inputs.routeKey)
        .sort(),
    ).toEqual([
      "ANY /saas/admin/{proxy+}",
      "ANY /saas/{proxy+}",
      "GET /health",
    ]);
  });

  it("lets a user pool that's passed in invoke the triggers, and leaves it as it is", async () => {
    new Saas("App", { existing: { userPool: "us-east-1_abc" } });
    await app.settle();

    expect(
      ofType("aws:cognito/userPool:UserPool").filter(
        (r) => r.kind === "register",
      ),
    ).toEqual([]);
    // Looked up once
    expect(ofType("aws:cognito/userPool:UserPool").map((r) => r.kind)).toEqual([
      "read",
    ]);
    const permissions = ofType("aws:lambda/permission:Permission").filter((r) =>
      r.name.startsWith("AppTriggerPermission"),
    );
    expect(permissions.map((r) => r.name).sort()).toEqual([
      "AppTriggerPermissionPostConfirmation",
      "AppTriggerPermissionPreTokenGeneration",
    ]);
    expect(permissions[0].inputs.principal).toBe("cognito-idp.amazonaws.com");
    const authorizer = ofType("aws:apigatewayv2/authorizer:Authorizer")[0]
      .inputs;
    expect(authorizer.jwtConfiguration.issuer).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc",
    );
  });

  it("is transformed like any component", async () => {
    new Saas("App", {
      clients: ["Web", "Mobile"],
      transform: {
        apiFunction: { memory: "512 MB" },
        users: {
          transform: { table: { pointInTimeRecovery: { enabled: true } } },
        },
        client: (args, _opts, _name, id) => {
          if (id === "Mobile") args.callbackUrls = ["myapp://callback"];
        },
      },
    });
    await app.settle();

    expect(find("AppApiFunctionFunction")!.inputs.memorySize).toBe(512);
    expect(find("AppUsersTable")!.inputs.pointInTimeRecovery).toEqual({
      enabled: true,
    });
    expect(find("AppClientMobileClient")!.inputs.callbackUrls).toEqual([
      "myapp://callback",
    ]);
    const authorizer = ofType("aws:apigatewayv2/authorizer:Authorizer")[0]
      .inputs;
    expect(authorizer.jwtConfiguration.audiences).toHaveLength(2);
  });

  describe("route()", () => {
    it("adds a route behind the authorizer, with the permission as a scope", async () => {
      const saas = new Saas("App");
      saas.route("POST /projects", "src/projects.create", {
        permission: "projects:write",
      });
      saas.route(
        "GET /stats",
        { handler: "src/stats.handler", memory: "256 MB" },
        {
          platformAdmin: true,
        },
      );
      await app.settle();

      const routes = Object.fromEntries(
        ofType("aws:apigatewayv2/route:Route").map((r) => [
          r.inputs.routeKey,
          r.inputs,
        ]),
      );
      expect(routes["POST /projects"]).toMatchObject({
        authorizationType: "JWT",
        authorizationScopes: ["tenant/projects:write", "tenant/*"],
      });
      expect(routes["GET /stats"].authorizationScopes).toEqual([
        "platform/admin",
      ]);

      const fns = app
        .graph()
        .filter(
          (r) =>
            r.type === "sst:aws:Function" &&
            r.build?.handler?.startsWith("src/"),
        );
      expect(fns.map((fn) => fn.build!.handler).sort()).toEqual([
        "src/projects.create",
        "src/stats.handler",
      ]);
      for (const fn of fns) {
        expect(Object.keys(fn.build!.links).sort()).toEqual([
          "AppMemberships",
          "AppTenants",
          "AppUsers",
        ]);
        expect(configOf(`${fn.name}Function`).store.type).toBe("dynamo");
      }
    });

    it("checks the permission's name", () => {
      const saas = new Saas("App");
      expect(() =>
        saas.route("GET /x", "src/x.handler", { permission: "*" }),
      ).toThrow(`The permission "*"`);
    });
  });

  it("gives a function that links it the config and access to the tables", async () => {
    const saas = new Saas("App");
    new v5.Function("Worker", { handler: "src/worker.handler", link: [saas] });
    await app.settle();

    const worker = find("WorkerFunction")!;
    expect(
      JSON.parse(worker.inputs.environment.variables.SAAS_CONFIG).store.type,
    ).toBe("dynamo");
    expect(Object.keys(buildOf("Worker")!.links)).toEqual(["App"]);
    const policy = JSON.stringify(
      app.resources
        .filter((r) => r.name.startsWith("WorkerRole"))
        .map((r) => r.inputs),
    );
    expect(policy).toContain("dynamodb:*");
    expect(policy).toContain("AppUsersTable");
  });
});
