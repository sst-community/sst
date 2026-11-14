import { lambda } from "@pulumi/aws";
import {
  ComponentResource,
  Input,
  Output,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { VisibleError } from "../../error";
import { Function, FunctionArn } from "../function";
import { splitQualifiedFunctionArn } from "./arn";

// The names of the shared handlers added to each API.
const names = new WeakMap<ComponentResource, Set<string>>();

/** A named Lambda target created by an API's `addHandler` method. */
export class ApiGatewayLambdaHandler {
  /** The shared invocation permission. */
  public readonly permission: lambda.Permission;
  public readonly arn: Output<FunctionArn>;

  /** @internal */
  constructor(
    private readonly api: ComponentResource,
    apiName: string,
    executionArn: Input<string>,
    name: string,
    handler: Function | Input<string>,
  ) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name))
      throw new VisibleError(
        `The shared handler name "${name}" must start with a letter and contain only letters and numbers.`,
      );
    const used = names.get(api) ?? new Set<string>();
    if (used.has(name))
      throw new VisibleError(
        `The shared handler "${name}" already exists in this API.`,
      );
    const check = (arn: string) => {
      if (
        !/^arn:[^:]+:lambda:[^:]+:\d{12}:function:[A-Za-z0-9_-]+(?::[A-Za-z0-9$_-]+)?$/.test(
          arn,
        )
      )
        throw new VisibleError(
          `The shared handler "${name}" needs a Lambda function, alias or version ARN, not "${arn}".`,
        );
      return arn as FunctionArn;
    };
    // A plain string fails here, before anything is registered.
    if (typeof handler === "string") check(handler);
    used.add(name);
    names.set(api, used);

    // A Function is invoked at its target, as `route(..., fn)` does: its version
    // when it's published or durable.
    this.arn = (
      handler instanceof Function ? handler.targetArn : output(handler)
    ).apply(check);
    const target = this.arn.apply(splitQualifiedFunctionArn);
    // Register outside apply so unknown ARNs cannot hide the permission in previews.
    this.permission = new lambda.Permission(
      `${apiName}Handler${name}Permission`,
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
