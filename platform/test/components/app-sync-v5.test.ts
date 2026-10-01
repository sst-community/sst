import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi, type TakeoverWay } from "../helpers/graph";

const pulumi = mockPulumi({
  // What the 4.x component wraps things in. They have nothing in AWS behind
  // them, and they go when the V5 component takes over.
  wrappers: /^sst:aws:AppSync(DataSource|Function|Resolver)::MyApi/,
  state: (args) => {
    switch (args.type) {
      case "aws:appsync/graphQLApi:GraphQLApi":
        return {
          uris: {
            GRAPHQL: "https://abc123.appsync-api.us-east-1.amazonaws.com/graphql",
          },
        };
      case "aws:appsync/domainName:DomainName":
        return {
          domainName: args.inputs.domainName ?? "api.example.com",
          appsyncDomainName: "d-abc.cloudfront.net",
          hostedZoneId: "Z2FDTNDATAQYW2",
        };
      case "aws:appsync/function:Function":
        return { functionId: `${args.name}_fid` };
      case "aws:acm/certificate:Certificate":
        return {
          domainValidationOptions: [
            {
              resourceRecordType: "CNAME",
              resourceRecordName: "_abc.api.example.com.",
              resourceRecordValue: "_def.acm-validations.aws.",
            },
          ],
        };
      default:
        return {};
    }
  },
  // A policy document comes back as what it was made from, so that the
  // policies of two roles can be compared.
  call: (args) =>
    args.token === "aws:iam/getPolicyDocument:getPolicyDocument"
      ? { json: JSON.stringify(args.inputs) }
      : undefined,
});

const FUNCTION_ARN = "arn:aws:lambda:us-east-1:123456789012:function:my-fn";
const CERT_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/abc";
const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/my-table";
const CODE = `
  export function request(ctx) { return {}; }
  export function response(ctx) { return ctx.result; }
`;

describe("AppSyncV5", () => {
  let AppSync: typeof import("../../src/components/aws/app-sync").AppSync;
  let AppSyncV5: typeof import("../../src/components/aws/app-sync-v5").AppSyncV5;
  let dir: string;
  let schema: string;

  let cloudflare: typeof import("../../src/components/cloudflare/dns");
  let vercel: typeof import("../../src/components/vercel/dns");

  beforeAll(async () => {
    cloudflare = await import("../../src/components/cloudflare/dns");
    vercel = await import("../../src/components/vercel/dns");
    ({ AppSync } = await import("../../src/components/aws/app-sync"));
    ({ AppSyncV5 } = await import("../../src/components/aws/app-sync-v5"));
    await import("../../src/components/aws/takeover/app-sync");
    await import("../../src/components/aws/takeover/function");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-sync-v5-"));
    schema = path.join(dir, "schema.graphql");
    fs.writeFileSync(schema, "type Query {\n  user: String\n}\n");
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => pulumi.reset());

  function registered(type: string) {
    return pulumi.resources.filter((r) => r.type === type);
  }

  describe("takes over a deployed AppSync", () => {
    const sources = [
      { name: "lambdaDS", lambda: FUNCTION_ARN },
      { name: "dynamoDS", dynamodb: TABLE_ARN },
      {
        name: "elasticDS",
        elasticSearch: "arn:aws:es:us-east-1:123456789012:domain/search",
      },
      {
        name: "openDS",
        openSearch: "arn:aws:opensearch:us-east-1:123456789012:domain/open",
      },
      {
        name: "eventsDS",
        eventBridge: "arn:aws:events:us-east-1:123456789012:event-bus/bus",
      },
      { name: "httpDS", http: "https://api.example.com" },
      {
        name: "rdsDS",
        rds: {
          cluster: "arn:aws:rds:us-east-1:123456789012:cluster:db",
          credentials: "arn:aws:secretsmanager:us-east-1:123456789012:secret:db",
        },
      },
      { name: "noneDS" },
    ];
    const dynamoDS = { name: "dynamoDS", dynamodb: TABLE_ARN };
    const sourceTransform = {
      dataSource: { description: "Users" },
      serviceRole: { path: "/appsync/" },
    };
    const withCode = { name: "getUser", dataSource: "dynamoDS", code: CODE };
    const withTemplates = {
      name: "listUsers",
      dataSource: "dynamoDS",
      requestMappingTemplate: `{ "version": "2018-05-29", "operation": "Scan" }`,
      responseMappingTemplate: `$utils.toJson($context.result.items)`,
    };
    const templates = {
      requestTemplate: `{ "version": "2017-02-28", "operation": "Scan" }`,
      responseTemplate: `$utils.toJson($context.result.items)`,
    };

    // AppSync creates the association of a custom domain, and the function of
    // a Lambda data source, at the top of the app, so with the app's provider
    // whatever the API is given. AppSyncV5 creates them inside the API, with
    // the API's provider, which replaces them.
    const withTheProvider =
      (...names: string[]) =>
      (way: TakeoverWay): [string, string[]][] =>
        way === "with another provider"
          ? names.map((name) => [name, ["options.provider"]])
          : [];
    const association = withTheProvider("MyApiDomainAssociation");

    pulumi.takeoverCases({
      original: () => AppSync,
      v5: () => AppSyncV5,
      cases: {
        "default API with a schema": {
          create: (AppSync, opts) => new AppSync("MyApi", { schema }, opts),
          check: () =>
            expect(
              registered("aws:appsync/graphQLApi:GraphQLApi")[0].inputs,
            ).toMatchObject({
              authenticationType: "API_KEY",
              schema: "type Query {\n  user: String\n}\n",
            }),
        },
        "the API's transform": {
          create: (AppSync, opts) =>
            new AppSync(
              "MyApi",
              {
                schema,
                transform: {
                  api: (args: any): undefined => {
                    args.authenticationType = "AWS_IAM";
                    args.xrayEnabled = true;
                  },
                },
              },
              opts,
            ),
          check: () =>
            expect(
              registered("aws:appsync/graphQLApi:GraphQLApi")[0].inputs
                .xrayEnabled,
            ).toBe(true),
        },
        "data sources of every kind": {
          create: (AppSync, opts) => {
            const api = new AppSync("MyApi", { schema }, opts);
            for (const source of sources) api.addDataSource(source);
          },
          wrappers: sources.length,
          // What was compared: each data source, and a role for the five
          // that need one, with a policy for its source.
          check: () => {
            const dataSources = Object.fromEntries(
              registered("aws:appsync/dataSource:DataSource").map((r) => [
                r.inputs.name,
                r.inputs,
              ]),
            );
            expect(
              sources.map((source) => dataSources[source.name].type),
            ).toEqual([
              "AWS_LAMBDA",
              "AMAZON_DYNAMODB",
              "AMAZON_ELASTICSEARCH",
              "AMAZON_OPENSEARCH_SERVICE",
              "AMAZON_EVENTBRIDGE",
              "HTTP",
              "RELATIONAL_DATABASE",
              "NONE",
            ]);
            expect(dataSources.dynamoDS.dynamodbConfig).toEqual({
              tableName: "my-table",
            });
            expect(dataSources.lambdaDS.lambdaConfig).toEqual({
              functionArn: FUNCTION_ARN,
            });
            const roles = registered("aws:iam/role:Role");
            expect(roles.map((r) => r.name).sort()).toEqual([
              "MyApiServiceRoleDynamoDS",
              "MyApiServiceRoleElasticDS",
              "MyApiServiceRoleEventsDS",
              "MyApiServiceRoleLambdaDS",
              "MyApiServiceRoleOpenDS",
            ]);
            const dynamo = roles.find(
              (r) => r.name === "MyApiServiceRoleDynamoDS",
            )!;
            expect(JSON.parse(dynamo.inputs.inlinePolicies[0].policy)).toEqual({
              statements: [{ actions: ["dynamodb:*"], resources: [TABLE_ARN] }],
            });
          },
        },
        "a data source's transform, set on the API": {
          original: (opts) =>
            new AppSync("MyApi", { schema }, opts).addDataSource({
              ...dynamoDS,
              transform: sourceTransform,
            }),
          v5: (opts) =>
            new AppSyncV5(
              "MyApi",
              { schema, transform: sourceTransform },
              opts,
            ).addDataSource(dynamoDS),
          wrappers: 1,
          check: () =>
            expect(registered("aws:iam/role:Role")[0].inputs.path).toBe(
              "/appsync/",
            ),
        },
        "AppSync functions": {
          original: (opts) => {
            const api = new AppSync("MyApi", { schema }, opts);
            const ds = api.addDataSource(dynamoDS);
            api.addFunction({ ...withCode, dataSource: ds.name });
            api.addFunction({
              ...withTemplates,
              transform: { function: { maxBatchSize: 10 } },
            });
          },
          v5: (opts) => {
            const api = new AppSyncV5(
              "MyApi",
              {
                schema,
                transform: {
                  function: (args, _opts, _name, id) => {
                    if (id === "listUsers") args.maxBatchSize = 10;
                  },
                },
              },
              opts,
            );
            const ds = api.addDataSource(dynamoDS);
            api.addFunction({ ...withCode, dataSource: ds.name });
            api.addFunction(withTemplates);
          },
          wrappers: 3,
          check: () =>
            expect(
              registered("aws:appsync/function:Function")
                .map((r) => [
                  r.inputs.name,
                  r.inputs.runtime?.name,
                  r.inputs.maxBatchSize,
                ])
                .sort(),
            ).toEqual([
              ["getUser", "APPSYNC_JS", undefined],
              ["listUsers", undefined, 10],
            ]),
        },
        "unit and pipeline resolvers": {
          original: (opts) => {
            const api = new AppSync("MyApi", { schema }, opts);
            const ds = api.addDataSource(dynamoDS);
            const fn = api.addFunction({
              name: "getUser",
              dataSource: ds.name,
            });
            api.addResolver("Query user", {
              dataSource: ds.name,
              ...templates,
            });
            api.addResolver("Query  users", {
              dataSource: "dynamoDS",
              code: CODE,
            });
            api.addResolver("Mutation createUser", {
              kind: "pipeline",
              functions: [fn.nodes.function.functionId],
              code: CODE,
              transform: { resolver: { cachingConfig: { ttl: 60 } } },
            });
          },
          v5: (opts) => {
            const api = new AppSyncV5(
              "MyApi",
              {
                schema,
                transform: {
                  resolver: (args, _opts, _name, operation) => {
                    if (operation === "Mutation createUser")
                      args.cachingConfig = { ttl: 60 };
                  },
                },
              },
              opts,
            );
            const ds = api.addDataSource(dynamoDS);
            api.addFunction({ name: "getUser", dataSource: ds.name });
            api
              .addResolver("Query user", { dataSource: ds.name, ...templates })
              .addResolver("Query  users", {
                dataSource: "dynamoDS",
                code: CODE,
              })
              .addResolver("Mutation createUser", {
                kind: "pipeline",
                functions: ["getUser"],
                code: CODE,
              });
          },
          wrappers: 5,
          check: () =>
            expect(
              registered("aws:appsync/resolver:Resolver")
                .map((r) => [
                  r.inputs.type,
                  r.inputs.field,
                  r.inputs.kind,
                  r.inputs.dataSource,
                  r.inputs.pipelineConfig,
                ])
                .sort(),
            ).toEqual([
              [
                "Mutation",
                "createUser",
                "PIPELINE",
                undefined,
                { functions: ["MyApiFunctionGetUser_fid"] },
              ],
              ["Query", "user", "UNIT", "dynamoDS", undefined],
              ["Query", "users", "UNIT", "dynamoDS", undefined],
            ]),
        },
        "a pipeline resolver given function ids": {
          original: (opts) => {
            const api = new AppSync("MyApi", { schema }, opts);
            const fn = api.addFunction({ name: "getUser", dataSource: "none" });
            api.addResolver("Query user", {
              kind: "pipeline",
              functions: [fn.nodes.function.functionId, "external-id"],
            });
          },
          v5: (opts) => {
            const api = new AppSyncV5("MyApi", { schema }, opts);
            const fn = api.addFunction({ name: "getUser", dataSource: "none" });
            api.addResolver("Query user", {
              kind: "pipeline",
              functions: [fn.functionId, "external-id"],
            });
          },
          wrappers: 2,
        },
        "a custom domain with its own certificate": {
          create: (AppSync, opts) =>
            new AppSync(
              "MyApi",
              {
                schema,
                domain: {
                  name: "api.example.com",
                  dns: false,
                  cert: CERT_ARN,
                } as const,
                transform: { domainName: { description: "GraphQL" } },
              },
              opts,
            ),
          changed: association,
          check: () =>
            expect(
              registered("aws:appsync/domainName:DomainName")[0].inputs,
            ).toEqual({
              certificateArn: CERT_ARN,
              description: "GraphQL",
              domainName: "api.example.com",
            }),
        },
        "a custom domain on Route 53": {
          create: (AppSync, opts) =>
            new AppSync("MyApi", { schema, domain: "api.example.com" }, opts),
          changed: association,
          check: () => {
            // The certificate, its records and the alias records are all there
            const types = pulumi.resources.map((r) => r.type);
            expect(types).toContain("sst:aws:Certificate");
            expect(registered("aws:route53/record:Record").length).toBe(3);
            // The certificate is created in us-east-1
            expect(
              registered("aws:acm/certificate:Certificate")[0].options.provider,
            ).toMatch(/AwsProvider\.sst\.us-east-1/);
          },
        },
        "a custom domain on Cloudflare": {
          create: (AppSync, opts) =>
            new AppSync(
              "MyApi",
              {
                schema,
                domain: {
                  name: "api.example.com",
                  dns: cloudflare.dns({ zone: "zone-1" }),
                },
              },
              opts,
            ),
          changed: association,
        },
        "a custom domain on Vercel": {
          create: (AppSync, opts) =>
            new AppSync(
              "MyApi",
              {
                schema,
                domain: {
                  name: "api.example.com",
                  dns: vercel.dns({ domain: "example.com" }),
                },
              },
              opts,
            ),
          changed: association,
        },
        "the function of a Lambda data source given as a handler": {
          create: (AppSync, opts) =>
            new AppSync("MyApi", { schema }, opts).addDataSource({
              name: "lambdaDS",
              lambda: "src/lambda.handler",
            }),
          wrappers: 1,
          changed: withTheProvider(
            "MyApiDataSourceLambdaDSFunctionLogGroup",
            "MyApiDataSourceLambdaDSFunctionRole",
            "MyApiDataSourceLambdaDSFunctionFunction",
            "MyApiDataSourceLambdaDSFunctionCode",
          ),
          // The function is now inside the API
          check: () => {
            const [fn] = registered("sst:aws:FunctionV5");
            expect(fn.name).toBe("MyApiDataSourceFunctionLambdaDS");
            expect(fn.parent.split("::").at(-1)).toBe("MyApi");
          },
        },
      },
    });
  });

  it("keeps each data source's resources under its name", async () => {
    const api = new AppSyncV5("MyApi", { schema });
    const lambdaDS = api.addDataSource({
      name: "lambdaDS",
      lambda: "src/lambda.handler",
    });
    const arnDS = api.addDataSource({ name: "arnDS", lambda: FUNCTION_ARN });
    const httpDS = api.addDataSource({ name: "httpDS", http: "https://a.com" });
    await pulumi.settle();

    expect(lambdaDS.constructor.name).toBe("DataSource");
    expect(Object.keys(api.nodes.dataSourceFunction)).toEqual([
      "lambdaDS",
      "arnDS",
    ]);
    expect(Object.keys(api.nodes.serviceRole)).toEqual(["lambdaDS", "arnDS"]);
    expect(api.nodes.dataSource.arnDS).toBe(arnDS);
    expect(api.nodes.dataSource.httpDS).toBe(httpDS);
    const fn = await pulumi.resolve(api.nodes.dataSourceFunction.lambdaDS);
    expect(fn.constructor.name).toBe("FunctionV5");
    expect(await pulumi.resolve(arnDS.name)).toBe("arnDS");
  });

  it("creates what names a data source after the data source", async () => {
    const api = new AppSyncV5("MyApi", { schema });
    api.addDataSource({ name: "dynamoDS", dynamodb: TABLE_ARN });
    api.addFunction({ name: "getUser", dataSource: "dynamoDS" });
    api.addResolver("Query user", { dataSource: "dynamoDS" });
    api.addResolver("Query other", { dataSource: "elsewhere" });
    await pulumi.settle();

    const dataSource = /aws:appsync\/dataSource:DataSource::MyApiDataSourceDynamoDS$/;
    const [fn] = registered("aws:appsync/function:Function");
    const resolvers = registered("aws:appsync/resolver:Resolver");
    const user = resolvers.find((r) => r.inputs.field === "user")!;
    const other = resolvers.find((r) => r.inputs.field === "other")!;
    const waits = (r: (typeof resolvers)[number]) =>
      r.options.dependencies.some((d: string) => dataSource.test(d));
    expect([waits(fn), waits(user), waits(other)]).toEqual([true, true, false]);
    expect([user.inputs.dataSource, other.inputs.dataSource]).toEqual([
      "dynamoDS",
      "elsewhere",
    ]);
  });

  it("tells a transform which data source it is given", async () => {
    const api = new AppSyncV5("MyApi", {
      schema,
      transform: {
        dataSource: (args, _opts, _name, dataSource) => {
          if (dataSource === "b") args.description = "Second";
        },
      },
    });
    api.addDataSource({ name: "a" });
    api.addDataSource({ name: "b" });
    await pulumi.settle();

    expect(
      registered("aws:appsync/dataSource:DataSource").map((r) => [
        r.inputs.name,
        r.inputs.description,
      ]),
    ).toEqual([
      ["a", undefined],
      ["b", "Second"],
    ]);
  });

  it("rejects what was already added", async () => {
    const api = new AppSyncV5("MyApi", { schema });
    api.addDataSource({ name: "ds" });
    api.addFunction({ name: "fn", dataSource: "ds" });
    api.addResolver("Query user", { dataSource: "ds" });
    expect(() => api.addDataSource({ name: "ds" })).toThrow(
      /already has a data source named "ds"/,
    );
    expect(() => api.addFunction({ name: "fn", dataSource: "ds" })).toThrow(
      /already has a function named "fn"/,
    );
    expect(() => api.addResolver(" Query   user ", { dataSource: "ds" })).toThrow(
      /already has a resolver named "Query user"/,
    );
    expect(() => api.addResolver("Query", {})).toThrow(/Invalid resolver Query/);
    expect(() => api.addResolver("Query user name", {})).toThrow(
      /Invalid resolver/,
    );
    await pulumi.settle();
  });

  it("needs one source for a data source", async () => {
    const api = new AppSyncV5("MyApi", { schema });
    expect(() =>
      api.addDataSource({ name: "ds", dynamodb: TABLE_ARN, http: "https://a.com" }),
    ).toThrow(/is given "dynamodb" and "http". A data source has one source/);
    await pulumi.settle();
  });

  it("says where a data source's, function's or resolver's transform goes", async () => {
    const api = new AppSyncV5("MyApi", { schema });
    const moved = /"transform" isn't an option here. Use the "transform" of "MyApi"/;
    expect(() =>
      api.addDataSource({ name: "ds", transform: { dataSource: {} } } as any),
    ).toThrow(moved);
    expect(() =>
      api.addFunction({ name: "fn", dataSource: "ds", transform: {} } as any),
    ).toThrow(moved);
    expect(() =>
      api.addResolver("Query user", { transform: { resolver: {} } } as any),
    ).toThrow(moved);
    await pulumi.settle();
  });

  it("needs a plain value for the domain", async () => {
    const { output } = await import("@pulumi/pulumi");
    expect(
      () =>
        new AppSyncV5("MyApi", {
          schema,
          domain: output("api.example.com") as any,
        }),
    ).toThrow(/"domain" of the "MyApi" API has to be a plain value/);
    await pulumi.settle();
  });

  it("needs a certificate when DNS is off", async () => {
    expect(
      () =>
        new AppSyncV5("MyApi", {
          schema,
          domain: { name: "api.example.com", dns: false },
        }),
    ).toThrow(/"cert" is required when "dns" is disabled/);
    await pulumi.settle();
  });

  it("uses the custom domain in its URL", async () => {
    const standard = new AppSyncV5("Plain", { schema });
    const custom = new AppSyncV5("Custom", {
      schema,
      domain: { name: "api.example.com", dns: false, cert: CERT_ARN },
    });
    const shared = new AppSyncV5("Shared", {
      schema,
      existing: { domainName: "graphql.example.com" },
    });
    await pulumi.settle();

    expect(
      await pulumi.resolve([standard.url, custom.url, shared.url, standard.id]),
    ).toEqual([
      "https://abc123.appsync-api.us-east-1.amazonaws.com/graphql",
      "https://api.example.com/graphql",
      "https://api.example.com/graphql",
      "PlainApi_id",
    ]);
    expect(standard.nodes.domainName).toBeUndefined();
    expect(standard.nodes.domainAssociation).toBeUndefined();
    expect(custom.nodes.certificate).toBeUndefined();
    expect(custom.nodes.domainAssociation).toBeDefined();
    // A domain name that's passed in is looked up and associated, not created
    const [looked] = registered("aws:appsync/domainName:DomainName").filter(
      (r) => r.name === "SharedDomainName",
    );
    expect([looked.kind, looked.options.id]).toEqual([
      "read",
      "graphql.example.com",
    ]);
    expect(shared.nodes.domainAssociation).toBeDefined();
    expect(
      () =>
        new AppSyncV5("Both", {
          schema,
          domain: "api.example.com",
          existing: { domainName: "graphql.example.com" },
        }),
    ).toThrow(/is given an existing "domainName"/);
    await pulumi.settle();
  });

  it("links with its URL", async () => {
    const api = new AppSyncV5("MyApi", { schema });
    await pulumi.settle();

    const link = (api as any).getSSTLink();
    expect(Object.keys(link)).toEqual(["properties"]);
    expect(await pulumi.resolve(link.properties.url)).toBe(
      "https://abc123.appsync-api.us-east-1.amazonaws.com/graphql",
    );
  });
});
