import { ComponentResourceOptions } from "@pulumi/pulumi";
import { apigateway } from "@pulumi/aws";
import { type ComponentArgs, component } from "../parts-component";
import type { Input } from "../input";
import type { ApiGatewayRestApiKeyArgs } from "./apigateway-rest";

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
  extends ApiGatewayRestApiKeyArgs,
    ComponentArgs<typeof parts> {
  /**
   * The API Gateway Usage Plan to use for the API key.
   */
  usagePlanId: Input<string>;
}

/**
 * The `ApiGatewayRestApiKey` component is internally used by the `ApiGatewayRestUsagePlan` component
 * to add API keys to [Amazon API Gateway REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-rest-api.html).
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `addApiKey` method of the `ApiGatewayRestUsagePlan` component.
 *
 * #### Switch from SST 4's `sst.aws.ApiGatewayV1ApiKey`
 *
 * Switching the API to `sst.aws.ApiGatewayRest` switches its keys, and keeps them. A
 * function linked to a key reads its `value` as before. It's named `ApiGatewayRestApiKey`,
 * as the API is `ApiGatewayRest`, and keeps its type, `sst:aws:ApiGatewayV1ApiKey`, so
 * `sst-env.d.ts` still lists a linked key as SST 4's `ApiGatewayV1ApiKey`.
 */
export class ApiGatewayRestApiKey extends component(
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
