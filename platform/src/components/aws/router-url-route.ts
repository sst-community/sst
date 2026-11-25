import { all } from "@pulumi/pulumi";
import type { ComponentResourceOptions, Input } from "@pulumi/pulumi";
import { Component } from "../component";
import {
  buildKvNamespace,
  createKvRouteData,
  parsePattern,
  updateKvRoutes,
} from "./router-base-route";
import type { RouterBaseRouteArgs } from "./router-base-route";
import type { ProtectionConfig, RouterUrlRouteArgs } from "./router";
import { toSeconds } from "../duration";
import { VisibleError } from "../error";

export interface Args extends RouterBaseRouteArgs {
  /**
   * The URL to route to.
   */
  url: Input<string>;
  /**
   * Additional arguments for the route.
   */
  routeArgs?: Input<RouterUrlRouteArgs>;
  /**
   * The protection configuration inherited from the Router.
   */
  protection: Input<ProtectionConfig>;
}

/**
 * The `RouterUrlRoute` component is internally used by the `Router` component
 * to add routes.
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `route` method of the `Router` component.
 */
export class RouterUrlRoute extends Component {
  constructor(name: string, args: Args, opts?: ComponentResourceOptions) {
    super(__pulumiType, name, args, opts);

    const self = this;

    all([args.url, args.pattern, args.routeArgs, args.protection]).apply(
      ([url, pattern, routeArgs, protection]) => {
        const u = new URL(url);
        const host = u.host;
        const protocol = u.protocol.slice(0, -1);
        const isLambdaFunctionUrl =
          /^[a-z0-9]{32}\.lambda-url\.[a-z0-9-]+\.on\.aws$/.test(u.hostname);
        // AWS Lambda web function endpoint hostnames (not fixed-length like
        // Function URLs): HomeRegion/PerRegion end in .lambda-web.<region>.on.aws;
        // MultiRegion ends in .lambda-web.global.on.aws.
        // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html
        const isLambdaWebEndpoint =
          /^[a-z0-9][a-z0-9-]*\.lambda-web\.([a-z0-9-]+)\.on\.aws$/.test(
            u.hostname,
          );
        const useOac =
          routeArgs?.protection === true &&
          (isLambdaFunctionUrl || isLambdaWebEndpoint) &&
          (protection.mode === "oac" ||
            protection.mode === "oac-with-edge-signing");

        if (
          useOac &&
          isLambdaWebEndpoint &&
          protection.mode === "oac-with-edge-signing"
        ) {
          throw new VisibleError(
            `Cannot route a Lambda web function endpoint through a Router with protection "oac-with-edge-signing". CloudFront rejects Lambda@Edge origin triggers on web function origins with OAC. Use protection "oac" instead.`,
          );
        }

        const patternData = parsePattern(pattern);
        const namespace = buildKvNamespace(name);
        createKvRouteData(name, args, self, namespace, {
          host,
          rewrite: routeArgs?.rewrite,
          origin: {
            protocol: useOac || protocol === "https" ? undefined : protocol,
            connectionAttempts: routeArgs?.connectionAttempts,
            ...(useOac
              ? {
                  originAccessControlConfig: {
                    enabled: true,
                    // Web function origins require always-amz-auth; classic
                    // Function URLs use always.
                    signingBehavior: isLambdaWebEndpoint
                      ? "always-amz-auth"
                      : "always",
                    signingProtocol: "sigv4",
                    originType: "lambda",
                  },
                }
              : {}),
            timeouts: (() => {
              const timeouts = [
                "connectionTimeout" as const,
                "readTimeout" as const,
                "keepAliveTimeout" as const,
              ].flatMap((k) => {
                const value = routeArgs?.[k];
                return value ? [[k, toSeconds(value)]] : [];
              });
              return timeouts.length ? Object.fromEntries(timeouts) : undefined;
            })(),
          },
        });
        updateKvRoutes(name, args, self, "url", namespace, patternData);
      },
    );
  }
}

const __pulumiType = "sst:aws:RouterUrlRoute";
// @ts-expect-error
RouterUrlRoute.__pulumiType = __pulumiType;
