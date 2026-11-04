import { ComponentResourceOptions, output } from "@pulumi/pulumi";
import { apigateway } from "@pulumi/aws";
import { type ComponentArgs, component } from "../../parts-component";
import type { Input } from "../../input";
import type {
  ApiGatewayV1ApiKeyArgs,
  ApiGatewayV1UsagePlanArgs,
} from "./apigatewayv1";
import { ApiGatewayV1ApiKey } from "./apigatewayv1-api-key";

const parts = () => ({
  /**
   * The API Gateway usage plan.
   */
  usagePlan: apigateway.UsagePlan,
});

export interface UsagePlanArgs
  extends ApiGatewayV1UsagePlanArgs,
    ComponentArgs<typeof parts> {
  /**
   * The API Gateway REST API to use for the usage plan.
   */
  apiId: Input<string>;
  /**
   * The stage of the API Gateway REST API.
   */
  apiStage: Input<string>;
}

/**
 * The `ApiGatewayV1UsagePlan` component is internally used by the `ApiGatewayV1` component
 * to add usage plans to [Amazon API Gateway REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-rest-api.html).
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `addUsagePlan` method of the `ApiGatewayV1` component.
 *
 * #### Switch from `sst.aws.ApiGatewayV1UsagePlan`
 *
 * Nothing changes: switching the API to `sst.aws.v5.ApiGatewayV1` switches its usage plans
 * and their keys, and keeps them.
 */
export class ApiGatewayV1UsagePlan extends component(
  "sst:aws:ApiGatewayV1UsagePlan",
  parts,
) {
  constructor(
    name: string,
    args: UsagePlanArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.part("usagePlan", {
      apiStages: [{ apiId: args.apiId, stage: args.apiStage }],
      quotaSettings:
        args.quota &&
        output(args.quota).apply((quota) => ({
          limit: quota.limit,
          period: quota.period.toUpperCase(),
          offset: quota.offset,
        })),
      throttleSettings:
        args.throttle &&
        output(args.throttle).apply((throttle) => ({
          burstLimit: throttle.burst,
          rateLimit: throttle.rate,
        })),
    });
  }

  /**
   * Add an API key to the API Gateway usage plan.
   *
   * @param name The name of the API key.
   * @param args Configure the API key.
   * @example
   * ```js title="sst.config.ts"
   * plan.addApiKey("MyKey", {
   *   value: "d41d8cd98f00b204e9800998ecf8427e",
   * });
   * ```
   */
  public addApiKey(name: string, args?: ApiGatewayV1ApiKeyArgs) {
    // Next to the plan, as SST 4 made it
    return new ApiGatewayV1ApiKey(
      name,
      { ...args, usagePlanId: this.nodes.usagePlan.id },
      { provider: this.componentOpts.provider },
    );
  }
}
