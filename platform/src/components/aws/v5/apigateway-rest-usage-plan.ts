import { ComponentResourceOptions, output } from "@pulumi/pulumi";
import { apigateway } from "@pulumi/aws";
import { type ComponentArgs, component } from "../../parts-component";
import type { Input } from "../../input";
import type {
  ApiGatewayRestApiKeyArgs,
  ApiGatewayRestUsagePlanArgs,
} from "./apigateway-rest";
import { ApiGatewayRestApiKey } from "./apigateway-rest-api-key";

const parts = () => ({
  /**
   * The API Gateway usage plan.
   */
  usagePlan: apigateway.UsagePlan,
});

export interface UsagePlanArgs
  extends ApiGatewayRestUsagePlanArgs,
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
 * The `ApiGatewayRestUsagePlan` component is internally used by the `ApiGatewayRest` component
 * to add usage plans to [Amazon API Gateway REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-rest-api.html).
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `addUsagePlan` method of the `ApiGatewayRest` component.
 *
 * #### Switch from `sst.aws.ApiGatewayV1UsagePlan`
 *
 * Switching the API to `sst.aws.v5.ApiGatewayRest` switches its usage plans and their keys,
 * and keeps them. It's named `ApiGatewayRestUsagePlan`, as the API is `ApiGatewayRest`,
 * and keeps its type, `sst:aws:ApiGatewayV1UsagePlan`.
 */
export class ApiGatewayRestUsagePlan extends component(
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
  public addApiKey(name: string, args?: ApiGatewayRestApiKeyArgs) {
    // Next to the plan, as SST 4 made it
    return new ApiGatewayRestApiKey(
      name,
      { ...args, usagePlanId: this.nodes.usagePlan.id },
      { provider: this.componentOpts.provider },
    );
  }
}
