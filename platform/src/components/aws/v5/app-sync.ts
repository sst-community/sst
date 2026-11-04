import fs from "fs/promises";
import { ComponentResourceOptions, interpolate, output } from "@pulumi/pulumi";
import { appsync, iam } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { notAnExistingPart, plain, withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { Function } from "./function";
import { parseDynamoArn } from "../helpers/arn";
import { type DomainArgs, domainOf } from "../helpers/domain";
import {
  type FunctionInput,
  type FunctionPart,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import { useProvider } from "../helpers/provider";

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

export interface AppSyncDomainArgs extends DomainArgs {
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
   *
   * To manually set up a domain on an unsupported provider, you'll need to:
   *
   * 1. [Validate that you own the domain](https://docs.aws.amazon.com/acm/latest/userguide/domain-ownership-validation.html) by creating an ACM certificate. You can either validate it by setting a DNS record or by verifying an email sent to the domain owner.
   * 2. Once validated, set the certificate ARN as the `cert` and set `dns` to `false`.
   * 3. Add the DNS records in your provider to point to the AppSync domain.
   *
   * @example
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: false,
   *     cert: "arn:aws:acm:us-east-1:112233445566:certificate/3a958790-8878-4cdc-a396-06d95064cf63"
   *   }
   * }
   * ```
   */
  cert?: Input<string>;
}

export interface AppSyncArgs extends ComponentArgs<typeof parts> {
  /**
   * Path to the GraphQL schema file. This path is relative to your `sst.config.ts`.
   * @example
   * ```js
   * {
   *   schema: "schema.graphql",
   * }
   * ```
   */
  schema: Input<string>;
  /**
   * Set a custom domain for your AppSync GraphQL API.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and Vercel. For other
   * providers, you'll need to pass in a `cert` that validates domain ownership and add the
   * DNS records.
   *
   * The domain has to be a plain value, and so do its `name` and `dns`: they decide the
   * certificate and the DNS records.
   *
   * :::tip
   * Built-in support for AWS Route 53, Cloudflare, and Vercel. And manual setup for other
   * providers.
   * :::
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
  domain?: string | Prettify<AppSyncDomainArgs>;
}

export interface AppSyncDataSourceArgs {
  /**
   * The name of the data source.
   * @example
   * ```js
   * {
   *   name: "lambdaDS"
   * }
   * ```
   */
  name: string;
  /**
   * The function behind a Lambda data source: its handler or its args, which are plain
   * values, or a function you already have, or its ARN.
   * @example
   * ```js
   * {
   *   lambda: "src/lambda.handler"
   * }
   * ```
   *
   * You can pass in the full function props.
   *
   * ```js
   * {
   *   lambda: {
   *     handler: "src/lambda.handler",
   *     timeout: "60 seconds"
   *   }
   * }
   * ```
   *
   * You can also pass in the function ARN.
   *
   * ```js
   * {
   *   lambda: "arn:aws:lambda:us-east-1:123456789012:function:my-function"
   * }
   * ```
   */
  lambda?: FunctionInput;
  /**
   * The ARN for the DynamoDB table.
   * @example
   * ```js
   * {
   *   dynamodb: "arn:aws:dynamodb:us-east-1:123456789012:table/my-table"
   * }
   * ```
   */
  dynamodb?: Input<string>;
  /**
   * The ARN for the Elasticsearch domain.
   * @example
   * ```js
   * {
   *   elasticSearch: "arn:aws:es:us-east-1:123456789012:domain/my-domain"
   * }
   * ```
   */
  elasticSearch?: Input<string>;
  /**
   * The ARN for the EventBridge event bus.
   * @example
   * ```js
   * {
   *   eventBridge: "arn:aws:events:us-east-1:123456789012:event-bus/my-event-bus"
   * }
   * ```
   */
  eventBridge?: Input<string>;
  /**
   * The URL for the HTTP endpoint.
   * @example
   * ```js
   * {
   *   http: "https://api.example.com"
   * }
   * ```
   */
  http?: Input<string>;
  /**
   * The ARN for the OpenSearch domain.
   * @example
   * ```js
   * {
   *   openSearch: "arn:aws:opensearch:us-east-1:123456789012:domain/my-domain"
   * }
   * ```
   */
  openSearch?: Input<string>;
  /**
   * Configure the RDS data source.
   * @example
   * ```js
   * {
   *   rds: {
   *     cluster: "arn:aws:rds:us-east-1:123456789012:cluster:my-cluster",
   *     credentials: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret"
   *   }
   * }
   * ```
   */
  rds?: Input<{
    /**
     * The ARN for the RDS cluster.
     */
    cluster: Input<string>;
    /**
     * The ARN for the credentials secret store.
     */
    credentials: Input<string>;
  }>;
}

export interface AppSyncResolverArgs {
  /**
   * The type of the resolver.
   * @default `"unit"`
   * @example
   * ```js
   * {
   *   kind: "pipeline"
   * }
   * ```
   */
  kind?: Input<"unit" | "pipeline">;
  /**
   * The data source this resolver is using. This only applies for `unit` resolvers.
   * @example
   * ```js
   * {
   *   dataSource: "lambdaDS"
   * }
   * ```
   */
  dataSource?: Input<string>;
  /**
   * The functions this resolver is using. This only applies for `pipeline` resolvers.
   * @example
   * ```js
   * {
   *   functions: ["myFunction1", "myFunction2"]
   * }
   * ```
   */
  functions?: Input<Input<string>[]>;
  /**
   * The function code that contains the request and response functions.
   * @example
   * ```js
   * {
   *   code: fs.readFileSync("functions.js")
   * }
   * ```
   */
  code?: Input<string>;
  /**
   * For `unit` resolvers, this is the request mapping template. And for `pipeline`
   * resolvers, this is the before mapping template.
   * @example
   * ```js
   * {
   *   requestTemplate: `{
   *     "version": "2017-02-28",
   *     "operation": "Scan"
   *   }`
   * }
   * ```
   */
  requestTemplate?: Input<string>;
  /**
   * For `unit` resolvers, this is the response mapping template. And for `pipeline`
   * resolvers, this is the after mapping template.
   * @example
   * ```js
   * {
   *   responseTemplate: `{
   *     "users": $utils.toJson($context.result.items)
   *   }`
   * }
   * ```
   */
  responseTemplate?: Input<string>;
}

export interface AppSyncFunctionArgs {
  /**
   * The name of the AppSync function.
   * @example
   * ```js
   * {
   *   name: "myFunction"
   * }
   * ```
   */
  name: string;
  /**
   * The data source this function is using.
   * @example
   * ```js
   * {
   *   dataSource: "lambdaDS"
   * }
   * ```
   */
  dataSource: Input<string>;
  /**
   * The function code that contains the request and response functions.
   * @example
   * ```js
   * {
   *   code: fs.readFileSync("functions.js")
   * }
   * ```
   */
  code?: Input<string>;
  /**
   * The function request mapping template.
   * @example
   * ```js
   * {
   *   requestMappingTemplate: `{
   *     "version": "2018-05-29",
   *     "operation": "Scan",
   *   }`,
   * }
   * ```
   */
  requestMappingTemplate?: Input<string>;
  /**
   * The function response mapping template.
   * @example
   * ```js
   * {
   *   responseMappingTemplate: `{
   *     "users": $utils.toJson($context.result.items)
   *   }`,
   * }
   * ```
   */
  responseMappingTemplate?: Input<string>;
}

/**
 * The `AppSync` component lets you add an [Amazon AppSync GraphQL API](https://docs.aws.amazon.com/appsync/latest/devguide/what-is-appsync.html) to your app.
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
 * const api = new sst.aws.v5.AppSync("MyApi", {
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
 * new sst.aws.v5.AppSync("MyApi", {
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
 * const api = new sst.aws.v5.AppSync("MyApi", {
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
 * const api = new sst.aws.v5.AppSync("MyApi", {
 *   schema: "schema.graphql",
 *   transform: {
 *     dataSourceFunction: (args, opts, name, dataSource) => {
 *       if (dataSource === "lambdaDS") args.timeout = "60 seconds";
 *     }
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.AppSync`
 *
 * Change `sst.aws.AppSync` to `sst.aws.v5.AppSync` and keep the name. The API, its data
 * sources, their roles and functions, its AppSync functions, its resolvers and its custom
 * domain are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const api = new sst.aws.AppSync("MyApi", { schema: "schema.graphql" });
 * const api = new sst.aws.v5.AppSync("MyApi", { schema: "schema.graphql" });
 * ```
 *
 * A few things work differently:
 *
 * - `addDataSource` returns the AppSync data source and `addFunction` the AppSync function,
 *   so `lambdaDS.name` reads the same. Their other resources are in the API's `nodes`, by
 *   name: `lambdaDS.nodes.function` becomes `api.nodes.dataSourceFunction.lambdaDS`.
 *   `addResolver` returns the API, so calls chain, and the resolver is
 *   `api.nodes.resolver["Query user"]`.
 * - The `transform` of a data source, function or resolver becomes the API's `transform`
 *   for `dataSource`, `serviceRole`, `dataSourceFunction`, `function` and `resolver`.
 * - `domain`, with its `name` and `dns`, has to be a plain value, not an output. So does a
 *   Lambda data source's handler or function args: they decide whether a function is
 *   created. A function you already have, or its ARN, can still be an output.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - `domain.dns` is an adapter SST 5's components use, like `sst.aws.dns()`,
 *   `sst.cloudflare.dns()` or `sst.vercel.dns()`. An object written by hand for SST 4's
 *   doesn't work.
 * - The DNS records that validate the certificate are named after the domain they
 *   validate, and a domain's hosted zone is found without a resource: SST 4's
 *   `HostedZoneLookup`, and Cloudflare's `ZoneLookup`, leave the state.
 * - What a data source, an AppSync function, a resolver or a custom domain creates is
 *   created inside the API, with the provider the API has. `sst.aws.AppSync` created it
 *   beside the API: a Lambda data source's function and the domain's association with
 *   your app's provider, and the rest with only a `provider` passed to the API itself. So
 *   if your API has a `provider`, a Lambda data source's function and the domain's
 *   association are replaced on switch; and if it takes its provider from a parent
 *   component or from `providers`, so is everything its data sources, AppSync functions
 *   and resolvers created. Remove them and deploy before you switch, then add them back.
 * - `nodes` has every resource, the certificate included.
 */
export class AppSync extends component("sst:aws:AppSync", parts) {
  constructor(
    name: string,
    args: AppSyncArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const api = this.part("api", {
      schema: output(args.schema).apply((schema) =>
        fs.readFile(schema, { encoding: "utf-8" }),
      ),
      authenticationType: "API_KEY",
    });

    const owner = `the "${name}" API`;
    const existingDomainName = this.existingPart("domainName");
    const domain = plain(args.domain, `The "domain" of ${owner}`);
    if (existingDomainName && domain)
      throw new VisibleError(
        `The "${name}" API is given an existing "domainName", so it doesn't create one. Remove its "domain".`,
      );
    // What's only used with a custom domain: its certificate, when the API
    // creates the domain name without a `cert`, and its association
    if (!domain || (typeof domain !== "string" && domain.cert))
      notAnExistingPart(
        args.existing,
        "certificate",
        owner,
        `It's the certificate of a custom domain the API creates: give "domain" a "name" and no "cert".`,
      );
    if (!domain && !existingDomainName)
      notAnExistingPart(
        args.existing,
        "domainAssociation",
        owner,
        `It associates the API with a custom domain: give the API a "domain", or a domain name in "existing.domainName".`,
      );

    const domainName =
      existingDomainName ?? (domain && this.createDomainName(domain));
    if (domainName)
      this.part("domainAssociation", {
        apiId: api.id,
        domainName: domainName.domainName,
      });

    this.report({ hint: this.url });
  }

  // The custom domain: its certificate, the domain name, and the DNS records
  // that point at it.
  private createDomainName(args: string | AppSyncDomainArgs) {
    const name = this.componentName;
    const domain = domainOf(args, `the "${name}" API`);

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
    domain.dns?.alias(
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
  public addDataSource(args: AppSyncDataSourceArgs) {
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
      ? functionPart(
          this,
          "dataSourceFunction",
          name,
          plainFunction(
            args.lambda,
            `The "lambda" of the "${name}" data source of the "${this.componentName}" API`,
          ),
          { description: `${this.componentName} data source` },
        )
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
  public addFunction(args: AppSyncFunctionArgs) {
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
  public addResolver(operation: string, args: AppSyncResolverArgs = {}) {
    const [type, field, ...rest] = operation.trim().split(/\s+/);
    if (!type || !field || rest.length > 0)
      throw new VisibleError(
        `The "${operation}" resolver of the "${this.componentName}" API isn't a type and a field. Write it like "Query user".`,
      );
    const id = `${type} ${field}`;
    this.assertNew("resolver", "resolver", id, args);

    this.part("resolver", id, {
      apiId: this.nodes.api.id,
      kind: withDefault(args.kind, "unit", (kind) => {
        if (kind === "unit" && args.functions)
          throw new VisibleError(
            `The "${id}" resolver of the "${this.componentName}" API is a "unit" resolver, which takes no "functions". Give it a "dataSource", or make it a "pipeline" resolver.`,
          );
        if (kind === "pipeline" && args.dataSource)
          throw new VisibleError(
            `The "${id}" resolver of the "${this.componentName}" API is a "pipeline" resolver, which takes no "dataSource". Give its "functions" their data sources.`,
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
  args: AppSyncDataSourceArgs,
  fn: FunctionPart | undefined,
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
