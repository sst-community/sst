import fs from "fs/promises";
import { ComponentResourceOptions, interpolate, output } from "@pulumi/pulumi";
import { appsync, iam } from "@pulumi/aws";
import {
  V5Args,
  component,
  deferred,
  many,
  optional,
} from "../parts-component";
import { withDefault } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { Function } from "./function";
import { parseDynamoArn } from "./helpers/arn";
import { CustomDomainArgs, customDomain } from "./helpers/custom-domain";
import { FunctionBuilder, functionPart } from "./helpers/function-builder";
import { useProvider } from "./helpers/provider";
import type {
  AppSyncArgs,
  AppSyncDataSourceArgs,
  AppSyncFunctionArgs,
  AppSyncResolverArgs,
} from "./app-sync";

const parts = () => ({
  /**
   * The Amazon AppSync GraphQL API.
   */
  api: appsync.GraphQLApi,
  /**
   * The certificate for the custom domain, created when `domain` is set
   * without a `cert`.
   */
  certificate: optional(DnsValidatedCertificate),
  /**
   * The AppSync custom domain name, when `domain` is set.
   */
  domainName: optional(appsync.DomainName),
  /**
   * The association between the custom domain name and the API.
   */
  domainAssociation: optional(appsync.DomainNameApiAssociation),
  /**
   * The API's data sources, by data source name.
   */
  dataSource: many(appsync.DataSource),
  /**
   * The function behind each Lambda data source, by data source name.
   */
  dataSourceFunction: many(deferred(Function)),
  /**
   * The IAM role AppSync assumes to reach each data source, by data source
   * name. HTTP, RDS and empty data sources don't have one.
   */
  serviceRole: many(iam.Role),
  /**
   * The API's AppSync functions, by function name.
   */
  function: many(appsync.Function),
  /**
   * The API's resolvers, by operation, like `Query user`.
   */
  resolver: many(appsync.Resolver),
});

export interface AppSyncV5DomainArgs extends CustomDomainArgs {
  /**
   * The ARN of an ACM (AWS Certificate Manager) certificate that proves ownership of the
   * domain. By default, a certificate is created and validated automatically.
   *
   * AppSync takes its certificate from the `us-east-1` region. The one that's created for
   * you is created there, and one you pass in has to be there too.
   *
   * :::tip
   * You need to pass in a `cert` for domains that are not hosted on supported `dns` providers.
   * :::
   */
  cert?: Input<string>;
}

export interface AppSyncV5Args
  extends V5Args<Omit<AppSyncArgs, "domain">, typeof parts> {
  /**
   * Set a custom domain for your AppSync GraphQL API.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and
   * Vercel. For other providers, pass in a `cert` that validates domain
   * ownership and add the DNS records yourself.
   *
   * @example
   *
   * By default this assumes the domain is hosted on Route 53.
   *
   * ```js
   * {
   *   domain: "example.com"
   * }
   * ```
   *
   * For domains hosted on Cloudflare.
   *
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   */
  domain?: string | AppSyncV5DomainArgs;
}

export interface AppSyncV5DataSourceArgs
  extends Omit<AppSyncDataSourceArgs, "transform"> {}

export interface AppSyncV5FunctionArgs
  extends Omit<AppSyncFunctionArgs, "transform"> {}

export interface AppSyncV5ResolverArgs
  extends Omit<AppSyncResolverArgs, "transform"> {}

/**
 * The `AppSyncV5` component lets you add an [Amazon AppSync GraphQL API](https://docs.aws.amazon.com/appsync/latest/devguide/what-is-appsync.html) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have. That includes the resources of each
 * data source, function and resolver.
 *
 * @example
 *
 * #### Create a GraphQL API
 *
 * ```ts title="sst.config.ts"
 * const api = new sst.aws.AppSyncV5("MyApi", {
 *   schema: "schema.graphql"
 * });
 * ```
 *
 * #### Add a data source
 *
 * ```ts title="sst.config.ts"
 * const lambdaDS = api.addDataSource({
 *   name: "lambdaDS",
 *   lambda: "src/lambda.handler"
 * });
 * ```
 *
 * #### Add a resolver
 *
 * ```ts title="sst.config.ts"
 * api.addResolver("Query user", {
 *   dataSource: lambdaDS.name
 * });
 * ```
 *
 * #### Add a pipeline resolver
 *
 * ```ts title="sst.config.ts"
 * api.addFunction({
 *   name: "getUser",
 *   dataSource: "lambdaDS"
 * });
 * api.addResolver("Query user", {
 *   kind: "pipeline",
 *   functions: ["getUser"],
 *   code: `
 *     export function request(ctx) { return {}; }
 *     export function response(ctx) { return ctx.prev.result; }
 *   `
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * ```js {3} title="sst.config.ts"
 * new sst.aws.AppSyncV5("MyApi", {
 *   schema: "schema.graphql",
 *   domain: "api.example.com"
 * });
 * ```
 *
 * #### Default props for all data sources
 *
 * Use the `transform` to change every data source, its function or its role. An object is
 * merged into each one.
 *
 * ```ts title="sst.config.ts" {4}
 * const api = new sst.aws.AppSyncV5("MyApi", {
 *   schema: "schema.graphql",
 *   transform: {
 *     dataSourceFunction: { memory: "2048 MB" }
 *   }
 * });
 * ```
 *
 * A function is also given the data source's name, so it can change one of them. The same
 * goes for `function`, by function name, and `resolver`, by operation.
 *
 * ```ts title="sst.config.ts"
 * const api = new sst.aws.AppSyncV5("MyApi", {
 *   schema: "schema.graphql",
 *   transform: {
 *     dataSourceFunction: (args, opts, name, dataSource) => {
 *       if (dataSource === "lambdaDS") args.timeout = "60 seconds";
 *     }
 *   }
 * });
 * ```
 *
 * #### Switch from `AppSync`
 *
 * Change `AppSync` to `AppSyncV5` and keep the name. The API, its data sources, their roles
 * and functions, its AppSync functions, its resolvers and its custom domain are kept. A few
 * things are written differently:
 *
 * - `addDataSource` returns the AppSync data source and `addFunction` the AppSync function,
 *   so `lambdaDS.name` reads the same. Their other resources are in the API's `nodes`, by
 *   name: `lambdaDS.nodes.function` becomes `api.nodes.dataSourceFunction.lambdaDS`.
 * - The `transform` of a data source, function or resolver becomes the API's `transform`
 *   for `dataSource`, `serviceRole`, `dataSourceFunction`, `function` and `resolver`.
 * - `domain` and `domain.dns` have to be plain values, not outputs.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const api = new sst.aws.AppSync("MyApi", { schema: "schema.graphql" });
 * const api = new sst.aws.AppSyncV5("MyApi", { schema: "schema.graphql" });
 * ```
 */
export class AppSyncV5 extends component("sst:aws:AppSyncV5", parts) {
  constructor(
    name: string,
    args: AppSyncV5Args,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const api = this.part("api", {
      schema: output(args.schema).apply((schema) =>
        fs.readFile(schema, { encoding: "utf-8" }),
      ),
      authenticationType: "API_KEY",
    });

    const existingDomainName = this.existingPart("domainName");
    if (existingDomainName && args.domain)
      throw new VisibleError(
        `The "${name}" API is given an existing "domainName", so it doesn't create one. Remove its "domain".`,
      );

    const domainName =
      existingDomainName ??
      (args.domain && this.createDomainName(args.domain));
    if (domainName)
      this.part("domainAssociation", {
        apiId: api.id,
        domainName: domainName.domainName,
      });

    this.registerOutputs({ _hint: this.url });
  }

  // The custom domain: its certificate, the domain name, and the DNS records
  // that point at it.
  private createDomainName(args: string | AppSyncV5DomainArgs) {
    const name = this.componentName;
    const domain = customDomain(args, `the "${name}" API`);

    // AppSync takes its certificate from us-east-1, whatever region the API
    // is in.
    const certificateArn =
      domain.cert ??
      this.part(
        "certificate",
        { domainName: domain.name, dns: domain.dns! },
        { provider: useProvider("us-east-1") },
      ).arn;
    const domainName = this.part("domainName", {
      domainName: domain.name,
      certificateArn,
    });
    domain.dns?.createAlias(
      name,
      {
        name: domain.name,
        aliasName: domainName.appsyncDomainName,
        aliasZone: domainName.hostedZoneId,
      },
      this.delegateOpts(),
    );
    return domainName;
  }

  /**
   * The GraphQL API ID.
   */
  public get id() {
    return this.nodes.api.id;
  }

  /**
   * The URL of the GraphQL API.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated AppSync URL.
   */
  public get url() {
    const { api, domainName } = this.nodes;
    return domainName
      ? interpolate`https://${domainName.domainName}/graphql`
      : api.uris["GRAPHQL"];
  }

  /**
   * Add a data source to this AppSync API.
   *
   * Returns the AppSync data source. Its `name` is what a resolver or a
   * function takes as its `dataSource`.
   *
   * @param args Configure the data source.
   *
   * @example
   *
   * Add a Lambda function as a data source.
   *
   * ```js title="sst.config.ts"
   * api.addDataSource({
   *   name: "lambdaDS",
   *   lambda: "src/lambda.handler"
   * });
   * ```
   *
   * Customize the Lambda function.
   *
   * ```js title="sst.config.ts"
   * api.addDataSource({
   *   name: "lambdaDS",
   *   lambda: {
   *     handler: "src/lambda.handler",
   *     timeout: "60 seconds"
   *   }
   * });
   * ```
   *
   * Add a data source with an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * api.addDataSource({
   *   name: "lambdaDS",
   *   lambda: "arn:aws:lambda:us-east-1:123456789012:function:my-function"
   * });
   * ```
   *
   * Add a DynamoDB table as a data source.
   *
   * ```js title="sst.config.ts"
   * api.addDataSource({
   *   name: "dynamoDS",
   *   dynamodb: "arn:aws:dynamodb:us-east-1:123456789012:table/my-table"
   * });
   * ```
   *
   * The data source's resources are in the API's `nodes`, by name.
   *
   * ```js title="sst.config.ts"
   * api.nodes.dataSourceFunction.lambdaDS;
   * api.nodes.serviceRole.dynamoDS;
   * ```
   */
  public addDataSource(args: AppSyncV5DataSourceArgs) {
    const { name } = args;
    this.assertNew("data source", "dataSource", name, args, [
      "dataSource",
      "serviceRole",
      "dataSourceFunction",
    ]);
    const given = SOURCES.filter((kind) => args[kind]);
    if (given.length > 1)
      throw new VisibleError(
        `The "${name}" data source of the "${this.componentName}" API is given ${given.map((kind) => `"${kind}"`).join(" and ")}. A data source has one source.`,
      );

    const fn = args.lambda
      ? functionPart(this, "dataSourceFunction", name, args.lambda, {
          description: `${this.componentName} data source`,
        })
      : undefined;
    const source = sourceOf(args, fn);

    const serviceRole =
      source.access &&
      this.part("serviceRole", name, {
        assumeRolePolicy: iam.getPolicyDocumentOutput({
          statements: [
            {
              actions: ["sts:AssumeRole"],
              principals: [
                { type: "Service", identifiers: ["appsync.amazonaws.com"] },
              ],
            },
          ],
        }).json,
        inlinePolicies: [
          {
            name: "inline",
            policy: iam.getPolicyDocumentOutput({
              statements: [source.access],
            }).json,
          },
        ],
      });

    return this.part("dataSource", name, {
      apiId: this.nodes.api.id,
      type: source.type,
      name,
      serviceRoleArn: serviceRole?.arn,
      ...source.config,
    });
  }

  /**
   * Add a function to this AppSync API, for use in pipeline resolvers.
   *
   * Returns the AppSync function.
   *
   * @param args Configure the function.
   *
   * @example
   *
   * Add a function using a Lambda data source.
   *
   * ```js title="sst.config.ts"
   * api.addFunction({
   *   name: "myFunction",
   *   dataSource: "lambdaDS"
   * });
   * ```
   *
   * Add a function using a DynamoDB data source.
   *
   * ```js title="sst.config.ts"
   * api.addFunction({
   *   name: "myFunction",
   *   dataSource: "dynamoDS",
   *   requestMappingTemplate: `{
   *     "version": "2018-05-29",
   *     "operation": "Scan"
   *   }`,
   *   responseMappingTemplate: `{
   *     "users": $utils.toJson($context.result.items)
   *   }`
   * });
   * ```
   */
  public addFunction(args: AppSyncV5FunctionArgs) {
    const { name } = args;
    this.assertNew("function", "function", name, args);

    return this.part("function", name, {
      apiId: this.nodes.api.id,
      name,
      dataSource: this.dataSourceName(args.dataSource),
      requestMappingTemplate: args.requestMappingTemplate,
      responseMappingTemplate: args.responseMappingTemplate,
      code: args.code,
      runtime: args.code ? APPSYNC_JS : undefined,
    });
  }

  /**
   * Add a resolver to this AppSync API.
   *
   * @param operation The type and name of the operation.
   * @param args Configure the resolver.
   *
   * @example
   *
   * Add a resolver using a Lambda data source.
   *
   * ```js title="sst.config.ts"
   * api.addResolver("Query user", {
   *   dataSource: "lambdaDS"
   * });
   * ```
   *
   * Add a resolver using a DynamoDB data source.
   *
   * ```js title="sst.config.ts"
   * api.addResolver("Query user", {
   *   dataSource: "dynamoDS",
   *   requestTemplate: `{
   *     "version": "2017-02-28",
   *     "operation": "Scan"
   *   }`,
   *   responseTemplate: `{
   *     "users": $utils.toJson($context.result.items)
   *   }`
   * });
   * ```
   *
   * Add a pipeline resolver. Its `functions` are the names of functions added
   * with `addFunction`, or the ids of AppSync functions.
   *
   * ```js title="sst.config.ts"
   * api.addResolver("Query user", {
   *   kind: "pipeline",
   *   functions: ["myFunction1", "myFunction2"],
   *   code: `
   *     export function request(ctx) {
   *       return {};
   *     }
   *     export function response(ctx) {
   *       return ctx.result;
   *     }
   *   `
   * });
   * ```
   *
   * The resolver is in the API's `nodes`, by operation.
   *
   * ```js title="sst.config.ts"
   * api.nodes.resolver["Query user"];
   * ```
   */
  public addResolver(operation: string, args: AppSyncV5ResolverArgs = {}) {
    const [type, field, ...rest] = operation.trim().split(/\s+/);
    if (!type || !field || rest.length > 0)
      throw new VisibleError(
        `Invalid resolver ${operation}. A resolver is added for a type and a field, like "Query user".`,
      );
    const id = `${type} ${field}`;
    this.assertNew("resolver", "resolver", id, args);

    this.part("resolver", id, {
      apiId: this.nodes.api.id,
      kind: withDefault(args.kind, "unit", (kind) => {
        if (kind === "unit" && args.functions)
          throw new VisibleError(
            "The `functions` property is not supported for `unit` resolvers.",
          );
        if (kind === "pipeline" && args.dataSource)
          throw new VisibleError(
            "The `dataSource` property is not supported for `pipeline` resolvers.",
          );
        return kind.toUpperCase();
      }),
      type,
      field,
      dataSource: this.dataSourceName(args.dataSource),
      requestTemplate: args.requestTemplate,
      responseTemplate: args.responseTemplate,
      code: args.code,
      runtime: args.code ? APPSYNC_JS : undefined,
      pipelineConfig: args.functions
        ? { functions: this.functionIds(args.functions) }
        : undefined,
    });

    return this;
  }

  // A data source's name, read off the data source when it's one of this
  // API's, so that what uses it is created after it.
  private dataSourceName<T extends Input<string> | undefined>(name: T) {
    const dataSources = this.nodes.dataSource;
    return typeof name === "string" && name in dataSources
      ? dataSources[name].name
      : name;
  }

  // The ids of a pipeline's functions. One of this API's functions can be
  // given by its name.
  private functionIds(functions: Input<Input<string>[]>) {
    if (!Array.isArray(functions)) return functions;
    const added = this.nodes.function;
    return functions.map((fn) =>
      typeof fn === "string" && fn in added ? added[fn].functionId : fn,
    );
  }

  /**
   * Linking an API gives the linked resource its URL.
   */
  public link() {
    return {
      properties: { url: this.url },
    };
  }
}

const APPSYNC_JS = { name: "APPSYNC_JS", runtimeVersion: "1.0.0" };

// What a data source can be backed by. It has one of them, or none.
const SOURCES = [
  "lambda",
  "dynamodb",
  "elasticSearch",
  "eventBridge",
  "http",
  "openSearch",
  "rds",
] as const;

// What a data source is backed by, in the terms AppSync takes: its type, its
// settings, and what its service role has to be allowed to do. A source
// without `access` needs no role.
function sourceOf(
  args: AppSyncV5DataSourceArgs,
  fn: FunctionBuilder | undefined,
): {
  type: string;
  access?: { actions: string[]; resources: Input<string>[] };
  config: Partial<appsync.DataSourceArgs>;
} {
  if (fn)
    return {
      type: "AWS_LAMBDA",
      access: { actions: ["lambda:*"], resources: [fn.targetArn] },
      config: { lambdaConfig: { functionArn: fn.targetArn } },
    };
  if (args.dynamodb)
    return {
      type: "AMAZON_DYNAMODB",
      access: { actions: ["dynamodb:*"], resources: [args.dynamodb] },
      config: {
        dynamodbConfig: {
          tableName: output(args.dynamodb).apply(
            (arn) => parseDynamoArn(arn).tableName,
          ),
        },
      },
    };
  if (args.elasticSearch)
    return {
      type: "AMAZON_ELASTICSEARCH",
      access: { actions: ["es:*"], resources: [args.elasticSearch] },
      config: { elasticsearchConfig: { endpoint: args.elasticSearch } },
    };
  if (args.eventBridge)
    return {
      type: "AMAZON_EVENTBRIDGE",
      access: { actions: ["events:*"], resources: [args.eventBridge] },
      config: { eventBridgeConfig: { eventBusArn: args.eventBridge } },
    };
  if (args.http)
    return { type: "HTTP", config: { httpConfig: { endpoint: args.http } } };
  if (args.openSearch)
    return {
      type: "AMAZON_OPENSEARCH_SERVICE",
      access: { actions: ["opensearch:*"], resources: [args.openSearch] },
      config: { opensearchserviceConfig: { endpoint: args.openSearch } },
    };
  if (args.rds)
    return {
      type: "RELATIONAL_DATABASE",
      config: {
        relationalDatabaseConfig: {
          httpEndpointConfig: {
            dbClusterIdentifier: output(args.rds).cluster,
            awsSecretStoreArn: output(args.rds).credentials,
          },
        },
      },
    };
  return { type: "NONE", config: {} };
}
