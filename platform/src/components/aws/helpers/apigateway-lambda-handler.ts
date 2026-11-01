import { lambda } from "@pulumi/aws";
import {
  ComponentResource,
  Input,
  Output,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { VisibleError } from "../../error";
import { FunctionArn } from "../function";
import { splitQualifiedFunctionArn } from "./arn";

/** A named Lambda target created by an API's `addHandler` method. */
export class ApiGatewayLambdaHandler {
  /** The shared invocation permission. */
  public readonly permission: lambda.Permission;
  public readonly arn: Output<FunctionArn>;

  /** @internal */
  constructor(
    name: string,
    arn: Input<string>,
    private readonly api: ComponentResource,
    executionArn: Input<string>,
  ) {
    this.arn = output(arn).apply((arn) => {
      if (!/^arn:[^:]+:lambda:[^:]+:[^:]+:function:[^:]+(?::[^:]+)?$/.test(arn))
        throw new VisibleError(
          `The shared handler "${name}" requires a Lambda function ARN.`,
        );
      return arn as FunctionArn;
    });
    const target = this.arn.apply(splitQualifiedFunctionArn);
    // Register outside apply so unknown ARNs cannot hide the permission in previews.
    this.permission = new lambda.Permission(
      name,
      {
        action: "lambda:InvokeFunction",
        function: target.unqualifiedArn,
        qualifier: target.apply(({ qualifier }) => qualifier!),
        principal: "apigateway.amazonaws.com",
        sourceArn: interpolate`${executionArn}/*`,
      },
      { parent: api },
    );
  }

  /** @internal */
  public forApi(api: ComponentResource) {
    if (api !== this.api)
      throw new VisibleError(
        "Cannot use a shared Lambda handler from a different API.",
      );
    return this.arn;
  }
}
