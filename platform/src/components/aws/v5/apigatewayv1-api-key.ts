import { ComponentResourceOptions } from "@pulumi/pulumi";
import { apigateway } from "@pulumi/aws";
import { type ComponentArgs, component } from "../../parts-component";
import type { Input } from "../../input";
import type { ApiGatewayV1ApiKeyArgs } from "./apigatewayv1";

const parts = () => ({
  /**
   * The API Gateway API key.
   */
  apiKey: apigateway.ApiKey,
  /**
   * The key's place in its usage plan.
   */
  usagePlanKey: apigateway.UsagePlanKey,
});

export interface ApiKeyArgs
  extends ApiGatewayV1ApiKeyArgs,
    ComponentArgs<typeof parts> {
  /**
   * The API Gateway Usage Plan to use for the API key.
   */
  usagePlanId: Input<string>;
}

/**
 * The `ApiGatewayV1ApiKey` component is internally used by the `ApiGatewayV1UsagePlan` component
 * to add API keys to [Amazon API Gateway REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-rest-api.html).
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `addApiKey` method of the `ApiGatewayV1UsagePlan` component.
 *
 * #### Switch from `sst.aws.ApiGatewayV1ApiKey`
 *
 * Nothing changes: switching the API to `sst.aws.v5.ApiGatewayV1` switches its keys, and
 * keeps them. A function linked to a key reads its `value` as before.
 */
export class ApiGatewayV1ApiKey extends component(
  "sst:aws:ApiGatewayV1ApiKey",
  parts,
) {
  constructor(name: string, args: ApiKeyArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);
    const key = this.part("apiKey", { value: args.value });
    this.part("usagePlanKey", {
      keyId: key.id,
      keyType: "API_KEY",
      usagePlanId: args.usagePlanId,
    });
  }

  /**
   * The API key value.
   */
  public get value() {
    return this.nodes.apiKey.value;
  }

  link() {
    return {
      properties: {
        value: this.value,
      },
    };
  }
}
