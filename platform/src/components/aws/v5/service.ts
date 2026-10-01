import {
  all,
  ComponentResourceOptions,
  interpolate,
  type Output,
  output,
} from "@pulumi/pulumi";
import {
  appautoscaling,
  cloudwatch,
  ec2,
  ecs,
  getRegionOutput,
  iam,
  lb,
  servicediscovery,
} from "@pulumi/aws";
import { Image } from "@pulumi/docker-build";
import {
  V5Args,
  component,
  deferred,
  many,
  optional,
} from "../../parts-component";
import { ifSet, notAnOption, plain, plainDeep, withDefault } from "../../args";
import { type DurationMinutes, toSeconds } from "../../duration";
import { VisibleError } from "../../error";
import { DevCommand } from "../../experimental/dev-command";
import type { Input } from "../../input";
import { hashStringToPrettyString } from "../../naming";
import { transformPart } from "../../transform";
import { Alb as OriginalAlb } from "../alb";
import { DnsValidatedCertificate } from "../dns-validated-certificate";
import type { CustomDomainArgs } from "../helpers/custom-domain";
import {
  type Container,
  type ContainerArgs,
  type FargateArgs,
  containerImage,
  containersOf,
  cpuOf,
  executionRoleArgs,
  logGroupArgs,
  memoryOf,
  type Network,
  networkOf,
  storageOf,
  taskDefinitionArgs,
  taskRoleArgs,
} from "../helpers/fargate";
import { listenerKey, targetKey } from "../helpers/load-balancer";
import {
  domainOf,
  forbidden,
  pointDomainAt,
  securityGroupArgs,
} from "../helpers/load-balancer-args";
import { URL_UNAVAILABLE } from "../linkable";
import type { ServiceArgs as OriginalServiceArgs } from "../service";
import { Alb } from "./alb";

const parts = () => ({
  /**
   * The Amazon ECS Execution Role.
   */
  executionRole: iam.Role,
  /**
   * The Amazon ECS Task Role. In `sst dev` it's the role each container's
   * command runs as on your machine.
   */
  taskRole: iam.Role,
  /**
   * The images built for the service's containers, by the container's name. There's
   * one for each container that's built from a Dockerfile. It's added once the
   * container's image settings are known.
   */
  image: many(Image),
  /**
   * The CloudWatch log groups of the service's containers, by the container's name.
   */
  logGroup: many(cloudwatch.LogGroup),
  /**
   * The Amazon ECS Task Definition.
   */
  taskDefinition: ecs.TaskDefinition,
  /**
   * The AWS Security Group of the load balancer. Only created when the service has a
   * load balancer of its own.
   */
  loadBalancerSecurityGroup: optional(ec2.SecurityGroup),
  /**
   * The AWS Load Balancer. Only created when `loadBalancer` is set, and not when the
   * service is attached to an `Alb`.
   */
  loadBalancer: optional(lb.LoadBalancer),
  /**
   * The certificate for the load balancer's custom domain, created when
   * `loadBalancer.domain` is set without a `cert`.
   */
  certificate: optional(DnsValidatedCertificate),
  /**
   * The AWS Load Balancer target groups, one for each container port traffic is
   * forwarded to. Its id is the container's name, the protocol and the port:
   * `MyServiceHTTP8080`.
   */
  target: many(lb.TargetGroup),
  /**
   * The AWS Load Balancer listeners, one for each port the load balancer listens on.
   * Its id is the protocol and the port: `HTTP80`.
   */
  listener: many(lb.Listener),
  /**
   * The AWS Load Balancer listener rules, one for each rule that has `conditions`.
   *
   * For a rule on an `Alb`, its id is the listener and the priority: `HTTPS443P100`.
   * For a rule on the service's own load balancer, it's the listener and a hash of
   * the conditions, so a function here is better off reading the rule's args.
   */
  listenerRule: many(lb.ListenerRule),
  /**
   * The AWS Cloud Map service. Only created when the cluster's VPC has a Cloud Map
   * namespace, which a VPC you pass in by its ids may not. So it's an output, and
   * reading it fails when there is no namespace.
   */
  cloudmapService: deferred(servicediscovery.Service),
  /**
   * The Amazon ECS Service.
   */
  service: ecs.Service,
  /**
   * The AWS Application Auto Scaling target.
   */
  autoScalingTarget: appautoscaling.Target,
  /**
   * The AWS Application Auto Scaling policy that tracks CPU utilization. Not created
   * when `scaling.cpuUtilization` is `false`.
   */
  autoScalingCpuPolicy: optional(appautoscaling.Policy),
  /**
   * The AWS Application Auto Scaling policy that tracks memory utilization. Not
   * created when `scaling.memoryUtilization` is `false`.
   */
  autoScalingMemoryPolicy: optional(appautoscaling.Policy),
  /**
   * The AWS Application Auto Scaling policy that tracks the requests each target
   * gets. Only created when `scaling.requestCount` is set.
   */
  autoScalingRequestCountPolicy: optional(appautoscaling.Policy),
  /**
   * What `sst dev` runs in place of each container, by the container's name. It's
   * added once the container's `dev` settings are known.
   */
  devCommand: many(DevCommand),
});

type Port = `${number}/${"http" | "https" | "tcp" | "udp" | "tcp_udp" | "tls"}`;
type AlbPort = `${number}/${"http" | "https"}`;

export interface ServiceContainerArgs extends ContainerArgs {
  /**
   * Configure the health check for the container. Same as the top-level
   * [`health`](#health).
   */
  health?: OriginalServiceArgs["health"];
  /**
   * Configure how this container works in `sst dev`. Same as the top-level
   * [`dev`](#dev).
   */
  dev?: {
    /**
     * The command that `sst dev` runs to start this in dev mode. Same as the top-level
     * [`dev.command`](#dev-command).
     */
    command: Input<string>;
    /**
     * Configure if you want to automatically start this when `sst dev` starts. Same as the
     * top-level [`dev.autostart`](#dev-autostart).
     */
    autostart?: Input<boolean>;
    /**
     * Change the directory from where the `command` is run. Same as the top-level
     * [`dev.directory`](#dev-directory).
     */
    directory?: Input<string>;
  };
}

export interface ServiceDomainArgs extends CustomDomainArgs {
  /**
   * The custom domain you want to use.
   *
   * @example
   * ```js
   * {
   *   domain: {
   *     name: "example.com"
   *   }
   * }
   * ```
   *
   * Can also include subdomains based on the current stage.
   *
   * ```js
   * {
   *   domain: {
   *     name: `${$app.stage}.example.com`
   *   }
   * }
   * ```
   *
   * Wildcard domains are supported.
   *
   * ```js
   * {
   *   domain: {
   *     name: "*.example.com"
   *   }
   * }
   * ```
   */
  name: Input<string>;
  /**
   * Alias domains that should be used. A plain list: each alias gets DNS records of
   * its own.
   *
   * @example
   * ```js {4}
   * {
   *   domain: {
   *     name: "app1.example.com",
   *     aliases: ["app2.example.com"]
   *   }
   * }
   * ```
   */
  aliases?: string[];
}

export interface ServiceRuleArgs {
  /**
   * The port and protocol the service listens on. Uses the format `{port}/{protocol}`.
   *
   * @example
   * ```js
   * {
   *   listen: "80/http"
   * }
   * ```
   */
  listen: Port;
  /**
   * The port and protocol of the container the service forwards the traffic to. Uses the
   * format `{port}/{protocol}`.
   *
   * @example
   * ```js
   * {
   *   forward: "80/http"
   * }
   * ```
   * @default The same port and protocol as `listen`.
   */
  forward?: Port;
  /**
   * The name of the container to forward the traffic to. This maps to the `name` defined in
   * `containers`.
   *
   * You only need this if there's more than one container. If there's only one container, the
   * traffic is automatically forwarded there.
   */
  container?: string;
  /**
   * The port and protocol to redirect the traffic to. Uses the format `{port}/{protocol}`.
   *
   * @example
   * ```js
   * {
   *   redirect: "80/http"
   * }
   * ```
   */
  redirect?: Port;
  /**
   * The conditions a request has to match for the rule to apply. Only applicable to
   * `http` and `https` protocols.
   *
   * These are plain values all the way down. The listener rule is named after them.
   */
  conditions?: {
    /**
     * Configure path-based routing. Only requests matching the path are forwarded to
     * the container.
     *
     * ```js
     * {
     *   path: "/api/*"
     * }
     * ```
     *
     * The path pattern is case-sensitive, supports wildcards, and can be up to 128
     * characters.
     * - `*` matches 0 or more characters. For example, `/api/*` matches `/api/` or
     *   `/api/orders`.
     * - `?` matches exactly 1 character. For example, `/api/?.png` matches `/api/a.png`.
     *
     * @default Requests to all paths are forwarded.
     */
    path?: string;
    /**
     * Configure query string based routing. Only requests matching one of the query
     * string conditions are forwarded to the container.
     *
     * Takes a list of `key`, the name of the query string parameter, and `value` pairs.
     * Where `value` is the value of the query string parameter. But it can be a pattern as well.
     *
     * If multiple `key` and `value` pairs are provided, it'll match requests with **any** of the
     * query string parameters.
     *
     * @default Query string is not checked when forwarding requests.
     *
     * @example
     *
     * For example, to match requests with query string `version=v1`.
     *
     * ```js
     * {
     *   query: [
     *     { key: "version", value: "v1" }
     *   ]
     * }
     * ```
     *
     * Or match requests with query string matching `env=test*`.
     *
     * ```js
     * {
     *   query: [
     *     { key: "env", value: "test*" }
     *   ]
     * }
     * ```
     *
     * Match requests with query string `version=v1` **or** `env=test*`.
     *
     * ```js
     * {
     *   query: [
     *     { key: "version", value: "v1" },
     *     { key: "env", value: "test*" }
     *   ]
     * }
     * ```
     *
     * Match requests with any query string key with value `example`.
     *
     * ```js
     * {
     *   query: [
     *     { value: "example" }
     *   ]
     * }
     * ```
     */
    query?: {
      /**
       * The name of the query string parameter.
       */
      key?: string;
      /**
       * The value of the query string parameter.
       *
       * If no `key` is provided, it'll match any request where a query string parameter with
       * the given value exists.
       */
      value: string;
    }[];
    /**
     * Configure header based routing. Only requests matching the header
     * name and values are forwarded to the container.
     *
     * Both the header name and values are case insensitive.
     *
     * @default Header is not checked when forwarding requests.
     *
     * @example
     *
     * For example, if you specify `X-Custom-Header` as the name and `Value1`
     * as a value, it will match requests with the header
     * `x-custom-header: value1` as well.
     *
     * ```js
     * {
     *   header: {
     *     name: "X-Custom-Header",
     *     values: ["Value1", "Value2", "Prefix*"]
     *   }
     * }
     * ```
     */
    header?: {
      /**
       * The name of the HTTP header field to check. This is case-insensitive.
       */
      name: string;
      /**
       * The values to match against the header value. The rule matches if the
       * request header matches any of these values. Values are case-insensitive
       * and support wildcards (`*` and `?`) for pattern matching.
       */
      values: string[];
    };
  };
}

export interface ServiceHealthCheckArgs {
  /**
   * The URL path to ping on the service for health checks. Only applicable to
   * `http` and `https` protocols.
   * @default `"/"`
   */
  path?: Input<string>;
  /**
   * The time period between each health check request. Must be between `5 seconds`
   * and `300 seconds`.
   * @default `"30 seconds"`
   */
  interval?: Input<DurationMinutes>;
  /**
   * The timeout for each health check request. If no response is received within this
   * time, it is considered failed. Must be between `2 seconds` and `120 seconds`.
   * @default `"5 seconds"`
   */
  timeout?: Input<DurationMinutes>;
  /**
   * The number of consecutive successful health check requests required to consider the
   * target healthy. Must be between 2 and 10.
   * @default `5`
   */
  healthyThreshold?: Input<number>;
  /**
   * The number of consecutive failed health check requests required to consider the
   * target unhealthy. Must be between 2 and 10.
   * @default `2`
   */
  unhealthyThreshold?: Input<number>;
  /**
   * One or more HTTP response codes the health check treats as successful. Only
   * applicable to `http` and `https` protocols.
   *
   * @default `"200"`
   * @example
   * ```js
   * {
   *   successCodes: "200-299"
   * }
   * ```
   */
  successCodes?: Input<string>;
}

export interface ServiceLoadBalancerArgs {
  /**
   * Configure if the load balancer should be public or private.
   *
   * When set to `false`, the load balancer endpoint will only be accessible within the
   * VPC.
   *
   * @default `true`
   */
  public?: Input<boolean>;
  /**
   * Set a custom domain for your load balancer endpoint.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and Vercel. For other
   * providers, you'll need to pass in a `cert` that validates domain ownership and add the
   * DNS records.
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
  domain?: string | ServiceDomainArgs;
  /**
   * Configure the mapping for the ports the load balancer listens to, forwards, or redirects to
   * the service.
   * This supports two types of protocols:
   *
   * 1. Application Layer Protocols: `http` and `https`. This'll create an [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html).
   * 2. Network Layer Protocols: `tcp`, `udp`, `tcp_udp`, and `tls`. This'll create a [Network Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/introduction.html).
   *
   * :::note
   * If you want to listen on `https` or `tls`, you need to specify a custom
   * `loadBalancer.domain`.
   * :::
   *
   * You **can not configure** both application and network layer protocols for the same
   * service.
   *
   * The list and each rule are plain values. They decide which listeners, target groups
   * and listener rules are created.
   *
   * @example
   * Here we are listening on port `80` and forwarding it to the service on port `8080`.
   * ```js
   * {
   *   rules: [
   *     { listen: "80/http", forward: "8080/http" }
   *   ]
   * }
   * ```
   *
   * The `forward` port and protocol defaults to the `listen` port and protocol. So in this
   * case both are `80/http`.
   *
   * ```js
   * {
   *   rules: [
   *     { listen: "80/http" }
   *   ]
   * }
   * ```
   *
   * If multiple containers are configured via the `containers` argument, you need to
   * specify which container the traffic should be forwarded to.
   *
   * ```js
   * {
   *   rules: [
   *     { listen: "80/http", container: "app" },
   *     { listen: "8000/http", container: "admin" }
   *   ]
   * }
   * ```
   *
   * You can also route the same port to multiple containers via path-based routing.
   *
   * ```js
   * {
   *   rules: [
   *     {
   *       listen: "80/http",
   *       container: "app",
   *       conditions: { path: "/api/*" }
   *     },
   *     {
   *       listen: "80/http",
   *       container: "admin",
   *       conditions: { path: "/admin/*" }
   *     }
   *   ]
   * }
   * ```
   *
   * Additionally, you can redirect traffic from one port to another. This is
   * commonly used to redirect http to https.
   *
   * ```js
   * {
   *   rules: [
   *     { listen: "80/http", redirect: "443/https" },
   *     { listen: "443/https", forward: "80/http" }
   *   ]
   * }
   * ```
   */
  rules: ServiceRuleArgs[];
  /**
   * Configure the health check that the load balancer runs on your containers.
   *
   * :::tip
   * This health check is different from the [`health`](#health) check.
   * :::
   *
   * This health check is run by the load balancer. While, `health` is run by ECS. This
   * cannot be disabled if you are using a load balancer. While the other is off by default.
   *
   * Since this cannot be disabled, here are some tips on how to debug an unhealthy
   * health check.
   *
   * <details>
   * <summary>How to debug a load balancer health check</summary>
   *
   * If you notice a `Unhealthy: Health checks failed` error, it's because the health
   * check has failed. When it fails, the load balancer will terminate the containers,
   * causing any requests to fail.
   *
   * Here's how to debug it:
   *
   * 1. Verify the health check path.
   *
   *    By default, the load balancer checks the `/` path. Ensure it's accessible in your
   *    containers. If your application runs on a different path, then update the path in
   *    the health check config accordingly.
   *
   * 2. Confirm the containers are operational.
   *
   *    Navigate to **ECS console** > select the **cluster** > go to the **Tasks tab** >
   *    choose **Any desired status** under the **Filter desired status** dropdown > select
   *    a task and check for errors under the **Logs tab**. If it has error that means that
   *    the container failed to start.
   *
   * 3. If the container was terminated by the load balancer while still starting up, try
   *    increasing the health check interval and timeout.
   * </details>
   *
   * For `http` and `https` the default is:
   *
   * ```js
   * {
   *   path: "/",
   *   healthyThreshold: 5,
   *   successCodes: "200",
   *   timeout: "5 seconds",
   *   unhealthyThreshold: 2,
   *   interval: "30 seconds"
   * }
   * ```
   *
   * For `tcp` and `udp` the default is:
   *
   * ```js
   * {
   *   healthyThreshold: 5,
   *   timeout: "6 seconds",
   *   unhealthyThreshold: 2,
   *   interval: "30 seconds"
   * }
   * ```
   *
   * @example
   *
   * To configure the health check, we use the _port/protocol_ format. Here we are
   * configuring a health check that pings the `/health` path on port `8080`
   * every 10 seconds.
   *
   * ```js
   * {
   *   rules: [
   *     { listen: "80/http", forward: "8080/http" }
   *   ],
   *   health: {
   *     "8080/http": {
   *       path: "/health",
   *       interval: "10 seconds"
   *     }
   *   }
   * }
   * ```
   */
  health?: Record<Port, Input<ServiceHealthCheckArgs>>;
}

export interface ServiceAlbRuleArgs {
  /**
   * The port and protocol to listen on, in `{port}/{protocol}` format. Must match a listener on the ALB.
   *
   * @example
   * ```js
   * {
   *   listen: "443/https"
   * }
   * ```
   */
  listen: AlbPort;
  /**
   * The container port and protocol to forward traffic to. Uses the format `{port}/{protocol}`.
   *
   * The protocol must match what the container actually speaks. Using `"3000/https"` when
   * the container speaks HTTP will cause health check failures.
   *
   * @example
   * ```js
   * {
   *   forward: "8080/http"
   * }
   * ```
   */
  forward: AlbPort;
  /**
   * The name of the container to forward the traffic to. Required when multiple containers
   * are configured.
   */
  container?: string;
  /**
   * The conditions for the listener rule. At least one condition (path, query, or header)
   * must be specified. The ALB owns the default action, and a service only adds conditional
   * rules.
   *
   * @example
   * ```js
   * {
   *   conditions: {
   *     path: "/api/*"
   *   }
   * }
   * ```
   */
  conditions: {
    /**
     * Path pattern to match. Supports wildcards (`*` and `?`).
     */
    path?: Input<string>;
    /**
     * Query string conditions.
     */
    query?: Input<
      Input<{
        key?: Input<string>;
        value: Input<string>;
      }>[]
    >;
    /**
     * HTTP header condition.
     */
    header?: Input<{
      name: Input<string>;
      values: Input<Input<string>>[];
    }>;
  };
  /**
   * Explicit priority for the listener rule (1–50000).
   * Must be unique per listener across ALL services sharing the ALB.
   * Use non-overlapping ranges per service (e.g., Service A: 100-199, Service B: 200-299).
   *
   * @example
   * ```js
   * {
   *   priority: 100
   * }
   * ```
   */
  priority: number;
}

export interface ServiceAlbArgs {
  /**
   * The `Alb` instance to attach this service to. When provided, the service creates
   * target groups and listener rules on the shared ALB instead of creating its own
   * load balancer.
   *
   * ECS tasks use the VPC's default security group, which allows all traffic within the
   * VPC CIDR. For tighter security, add an explicit security group ingress rule from the
   * ALB's security group using `transform`.
   *
   * @example
   * ```js
   * {
   *   loadBalancer: {
   *     instance: alb,
   *     rules: [
   *       { listen: "443/https", forward: "8080/http", conditions: { path: "/api/*" }, priority: 100 }
   *     ]
   *   }
   * }
   * ```
   */
  instance: OriginalAlb | Alb;
  /**
   * The rules for routing traffic from the ALB to this service's containers.
   * Each rule must have explicit conditions and priority.
   */
  rules: ServiceAlbRuleArgs[];
  /**
   * Configure health checks for the target groups, keyed by the `{port}/{protocol}` the
   * traffic is forwarded to.
   */
  health?: Record<AlbPort, Input<ServiceHealthCheckArgs>>;
}

export interface ServiceArgs
  extends V5Args<
      Omit<
        OriginalServiceArgs,
        | "cluster"
        | "containers"
        | "volumes"
        | "taskRole"
        | "executionRole"
        | "public"
        | "loadBalancer"
        | "scaling"
      >,
      typeof parts
    >,
    FargateArgs {
  /**
   * Configure a load balancer to route traffic to the containers.
   *
   * While you can expose a service through API Gateway, it's better to use a load balancer
   * for most traditional web applications. It is more expensive to start but at higher
   * levels of traffic it ends up being more cost effective.
   *
   * Also, if you need to listen on network layer protocols like `tcp` or `udp`, you have to
   * expose it through a load balancer.
   *
   * By default, the endpoint is an auto-generated load balancer URL. You can also add a
   * custom domain for the endpoint.
   *
   * This has to be a plain value, and so do its `domain` and `rules`. They decide which
   * resources are created.
   *
   * @default Load balancer is not created
   * @example
   *
   * ```js
   * {
   *   loadBalancer: {
   *     domain: "example.com",
   *     rules: [
   *       { listen: "80/http", redirect: "443/https" },
   *       { listen: "443/https", forward: "80/http" }
   *     ]
   *   }
   * }
   * ```
   *
   * To share a load balancer between services, pass in an `Alb`. The service then adds
   * its target groups and listener rules to it.
   *
   * ```js
   * {
   *   loadBalancer: {
   *     instance: alb,
   *     rules: [
   *       { listen: "443/https", forward: "8080/http", conditions: { path: "/api/*" }, priority: 100 }
   *     ]
   *   }
   * }
   * ```
   */
  loadBalancer?: ServiceLoadBalancerArgs | ServiceAlbArgs;
  /**
   * Configure the service to automatically scale up or down based on the CPU or memory
   * utilization of a container. By default, scaling is disabled and the service will run
   * in a single container.
   *
   * This has to be a plain value, and so do `cpuUtilization`, `memoryUtilization` and
   * `requestCount`. They decide which scaling policies are created.
   *
   * @default `{ min: 1, max: 1 }`
   *
   * @example
   * ```js
   * {
   *   scaling: {
   *     min: 4,
   *     max: 16,
   *     cpuUtilization: 50,
   *     memoryUtilization: 50
   *   }
   * }
   * ```
   */
  scaling?: {
    /**
     * The minimum number of containers to scale down to.
     * @default `1`
     * @example
     * ```js
     * {
     *   scaling: {
     *     min: 4
     *   }
     * }
     * ```
     */
    min?: Input<number>;
    /**
     * The maximum number of containers to scale up to.
     * @default `1`
     * @example
     * ```js
     * {
     *   scaling: {
     *     max: 16
     *   }
     * }
     * ```
     */
    max?: Input<number>;
    /**
     * The target CPU utilization percentage to scale up or down. It'll scale up
     * when the CPU utilization is above the target and scale down when it's below the target.
     * @default `70`
     * @example
     * ```js
     * {
     *   scaling: {
     *     cpuUtilization: 50
     *   }
     * }
     * ```
     */
    cpuUtilization?: false | number;
    /**
     * The target memory utilization percentage to scale up or down. It'll scale up
     * when the memory utilization is above the target and scale down when it's below the target.
     * @default `70`
     * @example
     * ```js
     * {
     *   scaling: {
     *     memoryUtilization: 50
     *   }
     * }
     * ```
     */
    memoryUtilization?: false | number;
    /**
     * The target request count to scale up or down. It'll scale up when the request count is
     * above the target and scale down when it's below the target.
     * @default `false`
     * @example
     * ```js
     * {
     *   scaling: {
     *     requestCount: 1500
     *   }
     * }
     * ```
     */
    requestCount?: false | number;
    /**
     * The amount of time, in seconds, after a scale-in activity completes before another scale-in activity can start.
     * This prevents the auto scaler from removing too many tasks too quickly.
     * @example
     * ```js
     * {
     *   scaling: {
     *     scaleInCooldown: "60 seconds"
     *   }
     * }
     * ```
     */
    scaleInCooldown?: Input<DurationMinutes>;
    /**
     * The amount of time, in seconds, after a scale-out activity completes before another scale-out activity can start.
     * This prevents the auto scaler from adding too many tasks too quickly.
     * @example
     * ```js
     * {
     *   scaling: {
     *     scaleOutCooldown: "60 seconds"
     *   }
     * }
     * ```
     */
    scaleOutCooldown?: Input<DurationMinutes>;
  };
  /**
   * The containers to run in the service.
   *
   * :::tip
   * You can optionally run multiple containers in a service.
   * :::
   *
   * By default this starts a single container. To add multiple containers in the service, pass
   * in an array of containers args.
   *
   * ```ts
   * {
   *   containers: [
   *     {
   *       name: "app",
   *       image: "nginxdemos/hello:plain-text"
   *     },
   *     {
   *       name: "admin",
   *       image: {
   *         context: "./admin",
   *         dockerfile: "Dockerfile"
   *       }
   *     }
   *   ]
   * }
   * ```
   *
   * If you specify `containers`, you cannot list the above args at the top-level. For example,
   * you **cannot** pass in `image` at the top level.
   *
   * ```diff lang="ts"
   * {
   * -  image: "nginxdemos/hello:plain-text",
   *   containers: [
   *     {
   *       name: "app",
   *       image: "nginxdemos/hello:plain-text"
   *     },
   *     {
   *       name: "admin",
   *       image: "nginxdemos/hello:plain-text"
   *     }
   *   ]
   * }
   * ```
   *
   * You will need to pass in `image` as a part of the `containers`.
   *
   * The list, each container and its `name` have to be plain values. What's inside a
   * container can be an output.
   */
  containers?: ServiceContainerArgs[];
}

/**
 * The `Service` component lets you create containers that are always running, like web or
 * application servers. It uses [Amazon ECS](https://aws.amazon.com/ecs/) on [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html).
 *
 * It takes the same args as [`sst.aws.Service`](/docs/component/aws/service) and creates the
 * same resources. It's built from parts, so every resource it creates can be transformed,
 * is available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a Service
 *
 * Services are run inside an ECS Cluster. If you haven't already, create one.
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const cluster = new sst.aws.v5.Cluster("MyCluster", { vpc });
 * ```
 *
 * Add the service to it.
 *
 * ```ts title="sst.config.ts"
 * const service = new sst.aws.v5.Service("MyService", { cluster });
 * ```
 *
 * #### Configure the container image
 *
 * By default, the service will look for a Dockerfile in the root directory. Optionally
 * configure the image context and dockerfile.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   image: {
 *     context: "./app",
 *     dockerfile: "Dockerfile"
 *   }
 * });
 * ```
 *
 * To add multiple containers in the service, pass in an array of containers args.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   containers: [
 *     {
 *       name: "app",
 *       image: "nginxdemos/hello:plain-text"
 *     },
 *     {
 *       name: "admin",
 *       image: {
 *         context: "./admin",
 *         dockerfile: "Dockerfile"
 *       }
 *     }
 *   ]
 * });
 * ```
 *
 * This is useful for running sidecar containers.
 *
 * #### Enable auto-scaling
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   scaling: {
 *     min: 4,
 *     max: 16,
 *     cpuUtilization: 50,
 *     memoryUtilization: 50
 *   }
 * });
 * ```
 *
 * #### Expose through API Gateway
 *
 * You can give your service a public URL by exposing it through API Gateway HTTP API. You can
 * also optionally give it a custom domain.
 *
 * ```ts title="sst.config.ts"
 * const service = new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   serviceRegistry: {
 *     port: 80
 *   }
 * });
 *
 * const api = new sst.aws.v5.ApiGatewayV2("MyApi", {
 *   vpc,
 *   domain: "example.com"
 * });
 * api.routePrivate("$default", service.nodes.cloudmapService.arn);
 * ```
 *
 * #### Add a load balancer
 *
 * You can also expose your service by adding a load balancer to it and optionally
 * adding a custom domain.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   loadBalancer: {
 *     domain: "example.com",
 *     rules: [
 *       { listen: "80/http" },
 *       { listen: "443/https", forward: "80/http" }
 *     ]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your service. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {5} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources in your service.
 *
 * ```ts title="app.ts"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Service discovery
 *
 * This component automatically creates a Cloud Map service host name for the
 * service. So anything in the same VPC can access it using the service's host name.
 *
 * For example, if you link the service to a Lambda function that's in the same VPC.
 *
 * ```ts title="sst.config.ts" {2,4}
 * new sst.aws.v5.Function("MyFunction", {
 *   vpc,
 *   url: true,
 *   link: [service],
 *   handler: "lambda.handler"
 * });
 * ```
 *
 * You can access the service by its host name using the [SDK](/docs/reference/sdk/).
 *
 * ```ts title="lambda.ts"
 * import { Resource } from "sst";
 *
 * await fetch(`http://${Resource.MyService.service}`);
 * ```
 *
 * [Check out an example](/docs/examples/#aws-cluster-service-discovery).
 *
 * #### Use roles you already have
 *
 * Pass the role, or its name.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   existing: {
 *     taskRole: "my-task-role",
 *     executionRole: "my-execution-role"
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.Service`
 *
 * Change `sst.aws.Service` to `sst.aws.v5.Service` and keep the name. The ECS service, its
 * task definition, roles, log groups and images, the load balancer with its listeners and
 * target groups, the Cloud Map service and the scaling policies are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const service = new sst.aws.Service("MyService", { cluster });
 * const service = new sst.aws.v5.Service("MyService", { cluster });
 * ```
 *
 * A few things are written differently:
 *
 * - `taskRole: "my-task-role"` becomes `existing: { taskRole: "my-task-role" }`, and the
 *   same for `executionRole`.
 * - `public`, which `sst.aws.Service` deprecated, is `loadBalancer`. Its `ports` are
 *   `rules`, and a rule's `path` is `conditions.path`.
 * - `loadBalancer`, its `domain`, its `rules` and each rule are plain values, not outputs.
 *   So are `scaling` and its `cpuUtilization`, `memoryUtilization` and `requestCount`, and
 *   the list of `containers`, each container and its `name`. They decide which resources
 *   are created.
 * - `nodes.service` and `nodes.taskDefinition` are the resources, not outputs of them.
 *   `nodes` also has the log groups, images, listeners, target groups and scaling
 *   policies.
 * - `nodes.loadBalancer` is the load balancer the service creates. For a service that's
 *   attached to an `Alb`, read it from the `Alb`.
 * - A `transform` function for `service`, `taskDefinition`, `logGroup`, `target` or
 *   `listener` is given outputs where `sst.aws.Service` gave it plain values. For a part
 *   there are several of, it's also given which one.
 * - `transform.listenerRule` applies to the rules of the service's own load balancer too,
 *   not only to the rules on an `Alb`.
 * - If you set part of the ECS service's `networkConfiguration` or
 *   `deploymentCircuitBreaker`, of a target group's `healthCheck`, or of the task
 *   definition's `runtimePlatform`, with an object in `transform`, the rest of it is kept.
 * - The service's load balancer is removed before its certificate. `sst.aws.Service`
 *   left the two in no order, so removing it could fail on a certificate that was still
 *   in use. Deploy once after you switch for this to take effect.
 *
 * One thing changes on the first deploy, and nothing in AWS: what `sst dev` runs for each
 * container is kept inside the service now, so it's listed as removed and created again.
 *
 * ---
 *
 * ### Cost
 *
 * By default, this uses a _Linux/X86_ _Fargate_ container with 0.25 vCPUs at $0.04048 per
 * vCPU per hour and 0.5 GB of memory at $0.004445 per GB per hour. It includes 20GB of
 * _Ephemeral Storage_ for free with additional storage at $0.000111 per GB per hour. Each
 * container also gets a public IPv4 address at $0.005 per hour.
 *
 * It works out to $0.04048 x 0.25 x 24 x 30 + $0.004445 x 0.5 x 24 x 30 + $0.005
 * x 24 x 30 or **$12 per month**.
 *
 * If you are using all Fargate Spot instances with `capacity: "spot"`, it's $0.01218784 x 0.25
 * x 24 x 30 + $0.00133831 x 0.5 x 24 x 30 + $0.005 x 24 x 30 or **$6 per month**
 *
 * Adjust this for the `cpu`, `memory` and `storage` you are using. And
 * check the prices for _Linux/ARM_ if you are using `arm64` as your `architecture`.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [Fargate pricing](https://aws.amazon.com/fargate/pricing/) and the
 * [Public IPv4 Address pricing](https://aws.amazon.com/vpc/pricing/) for more details.
 *
 * #### Scaling
 *
 * By default, `scaling` is disabled. If enabled, adjust the above for the number of containers.
 *
 * #### API Gateway
 *
 * If you expose your service through API Gateway, you'll need to add the cost of
 * [API Gateway HTTP API](https://aws.amazon.com/api-gateway/pricing/#HTTP_APIs) as well.
 * For services that don't get a lot of traffic, this ends up being a lot cheaper since API
 * Gateway is pay per request.
 *
 * Learn more about using
 * [Cluster with API Gateway](/docs/examples/#aws-cluster-with-api-gateway).
 *
 * #### Application Load Balancer
 *
 * If you add `loadBalancer` _HTTP_ or _HTTPS_ `rules`, an ALB is created at $0.0225 per hour,
 * $0.008 per LCU-hour, and $0.005 per hour if HTTPS with a custom domain is used. Where LCU
 * is a measure of how much traffic is processed.
 *
 * That works out to $0.0225 x 24 x 30 or **$16 per month**. Add $0.005 x 24 x 30 or **$4 per
 * month** for HTTPS. Also add the LCU-hour used.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [Application Load Balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)
 * for more details.
 *
 * #### Network Load Balancer
 *
 * If you add `loadBalancer` _TCP_, _UDP_, or _TLS_ `rules`, an NLB is created at $0.0225 per hour and
 * $0.006 per NLCU-hour. Where NCLU is a measure of how much traffic is processed.
 *
 * That works out to $0.0225 x 24 x 30 or **$16 per month**. Also add the NLCU-hour used.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [Network Load Balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)
 * for more details.
 */
export class Service extends component("sst:aws:Service", parts) {
  // How the service is reached: what the getters and the link read
  private readonly reach: {
    url?: Output<string>;
    // Its host name in the cluster's Cloud Map namespace, when there is one
    host: Output<string | undefined>;
  };

  constructor(
    name: string,
    args: ServiceArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    for (const role of ["taskRole", "executionRole"])
      notAnOption(
        args,
        role,
        `Pass the role, or its name, as "existing: { ${role} }" in the "${name}" service.`,
      );
    // An image that's built is a part. One that exists already is just the
    // image a container is given.
    notAnOption(
      args.existing ?? {},
      "image",
      `Set the "image" of the container to the image's reference in the "${name}" service.`,
    );
    notAnOption(
      args,
      "public",
      `It's "loadBalancer" now, with the same settings, in the "${name}" service.`,
    );

    const cluster = args.cluster;
    // In `sst dev` the service isn't deployed. Each container's command runs
    // on the user's machine, as the task role.
    const dev =
      plain(args.dev, `The "dev" of the "${name}" service`) !== false && $dev;
    const region = getRegionOutput({}, opts).region;
    const architecture = withDefault(args.architecture, "x86_64" as const);
    const cpu = cpuOf(args);
    const memory = memoryOf(cpu, args);
    const storage = storageOf(args);
    const containers = containersOf("service", args, name);
    const balancer = loadBalancerOf(name, args.loadBalancer, containers);
    const scaling = scalingOf(name, args.scaling, balancer);
    const vpc = networkOf(cluster);

    const taskRole = this.part("taskRole", taskRoleArgs(args, opts, dev));

    // What `sst dev` runs in place of each container, in a tab of its own.
    // The settings are read first: `sst dev` is told them as they are.
    for (const container of containers)
      all([container.dev, container.image]).apply(([dev, image]) =>
        this.part("devCommand", container.name, {
          link: args.link,
          dev: {
            title: containers.length === 1 ? name : `${name}${container.name}`,
            autostart: true,
            directory: typeof image === "string" ? "" : image?.context ?? ".",
            ...dev,
          },
          environment: output(container.environment).apply((environment) => ({
            ...environment,
            AWS_REGION: region,
          })),
          aws: { role: taskRole.arn },
        }),
      );

    if (dev) {
      this.runsLocally();
      this.reach = {
        url: balancer
          ? output((args.dev || undefined)?.url ?? URL_UNAVAILABLE)
          : undefined,
        host: vpc.cloudmapNamespaceName.apply((namespace) =>
          namespace ? `dev.${namespace}` : undefined,
        ),
      };
      return;
    }

    const executionRole = this.part(
      "executionRole",
      executionRoleArgs(args, opts),
    );
    const taskDefinition = this.part(
      "taskDefinition",
      taskDefinitionArgs({
        name,
        cluster,
        region,
        link: args.link,
        // Each container, with the image it runs and the log group it writes to
        containers: containers.map((container) => ({
          container,
          image: containerImage(this, "image", container, {
            architecture,
            link: args.link,
            region,
          }),
          logGroup: this.part(
            "logGroup",
            container.name,
            logGroupArgs(container, cluster, name),
            { ignoreChanges: ["name"] },
          ),
        })),
        architecture,
        cpu,
        memory,
        storage,
        taskRole,
        executionRole,
      }),
    );

    const routing = !balancer
      ? undefined
      : "alb" in balancer
        ? this.attachToAlb(balancer, vpc)
        : this.createLoadBalancer(balancer, vpc);
    const cloudmapService = this.createCloudmapService(
      vpc,
      args.serviceRegistry,
    );

    const service = this.part(
      "service",
      {
        name,
        cluster: cluster.nodes.cluster.arn,
        taskDefinition: taskDefinition.arn,
        desiredCount: scaling.min,
        ...(args.capacity
          ? {
              // setting `forceNewDeployment` ensures that the service is not recreated
              // when the capacity provider config changes.
              forceNewDeployment: true,
              capacityProviderStrategies: output(args.capacity).apply(
                capacityStrategies,
              ),
            }
          : // @deprecated do not use `launchType`, set `capacityProviderStrategies`
            // to `[{ capacityProvider: "FARGATE", weight: 1 }]` instead
            { launchType: "FARGATE" }),
        networkConfiguration: {
          // If the vpc is an SST vpc, services are automatically deployed to the public
          // subnets. So we need to assign a public IP for the service to be accessible.
          assignPublicIp: vpc.isSstVpc,
          subnets: vpc.containerSubnets,
          securityGroups: vpc.securityGroups,
        },
        deploymentCircuitBreaker: {
          enable: true,
          rollback: true,
        },
        loadBalancers: (routing?.targets ?? []).map((target) => ({
          targetGroupArn: target.group.arn,
          containerName: target.container,
          containerPort: target.port,
        })),
        enableExecuteCommand: true,
        serviceRegistries: cloudmapService.apply((registry) =>
          registry
            ? {
                registryArn: registry.arn,
                port: args.serviceRegistry
                  ? output(args.serviceRegistry).port
                  : undefined,
              }
            : undefined,
        ) as ecs.ServiceArgs["serviceRegistries"],
        waitForSteadyState: withDefault(args.wait, false),
      },
      // A target group has to be on a load balancer before a service can use
      // it, and it's a listener or a listener rule that puts it there
      { dependsOn: routing?.routes },
    );

    const autoScalingTarget = this.part("autoScalingTarget", {
      serviceNamespace: "ecs",
      scalableDimension: "ecs:service:DesiredCount",
      resourceId: interpolate`service/${cluster.nodes.cluster.name}/${service.name}`,
      maxCapacity: scaling.max,
      minCapacity: scaling.min,
    });
    // A policy that keeps a metric at a target value
    const tracking = (
      metric: {
        predefinedMetricType: string;
        resourceLabel?: Input<string>;
      },
      targetValue: number,
    ): appautoscaling.PolicyArgs => ({
      serviceNamespace: autoScalingTarget.serviceNamespace,
      scalableDimension: autoScalingTarget.scalableDimension,
      resourceId: autoScalingTarget.resourceId,
      policyType: "TargetTrackingScaling",
      targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: metric,
        targetValue,
        scaleInCooldown: scaling.scaleInCooldown,
        scaleOutCooldown: scaling.scaleOutCooldown,
      },
    });
    if (scaling.cpuUtilization !== false)
      this.part(
        "autoScalingCpuPolicy",
        tracking(
          { predefinedMetricType: "ECSServiceAverageCPUUtilization" },
          scaling.cpuUtilization,
        ),
      );
    if (scaling.memoryUtilization !== false)
      this.part(
        "autoScalingMemoryPolicy",
        tracking(
          { predefinedMetricType: "ECSServiceAverageMemoryUtilization" },
          scaling.memoryUtilization,
        ),
      );
    if (scaling.requestCount !== false && routing) {
      const [target] = routing.targets;
      if (!target)
        throw new VisibleError(
          `"scaling.requestCount" needs a rule that forwards to a container in the "${name}" service. All of its rules redirect.`,
        );
      this.part(
        "autoScalingRequestCountPolicy",
        tracking(
          {
            predefinedMetricType: "ALBRequestCountPerTarget",
            resourceLabel: all([routing.arn, target.group.arn]).apply(
              ([lbArn, targetGroupArn]) => {
                // arn:...:loadbalancer/app/frank-MyServiceLoadBalan/005af2ad12da1e52
                // => app/frank-MyServiceLoadBalan/005af2ad12da1e52
                const lbPart = lbArn
                  .split(":")
                  .pop()
                  ?.split("/")
                  .slice(1)
                  .join("/");
                // arn:...:targetgroup/HTTP20250103004618450100000001/e0811b8cf3a60762
                // => targetgroup/HTTP20250103004618450100000001
                const tgPart = targetGroupArn.split(":").pop();
                return `${lbPart}/${tgPart}`;
              },
            ),
          },
          scaling.requestCount,
        ),
      );
    }

    this.reach = {
      url: routing?.url,
      host: all([vpc.cloudmapNamespaceName, cloudmapService]).apply(
        ([namespace, registry]) =>
          namespace && registry
            ? registry.name.apply(
                (service): string => `${service}.${namespace}`,
              )
            : output(undefined),
      ),
    };

    this.registerOutputs({ _hint: this.reach.url });
  }

  // The service's own load balancer. Each port it listens on has a listener,
  // which sends a request to the target group of a container port, or
  // redirects it. A rule with conditions is a listener rule.
  private createLoadBalancer(balancer: OwnBalancer, vpc: Network): Routing {
    const name = this.componentName;
    const { domain } = balancer;

    const securityGroup = this.part(
      "loadBalancerSecurityGroup",
      securityGroupArgs(vpc.id),
    );
    const certificate =
      domain && !domain.cert
        ? this.part("certificate", {
            domainName: domain.name,
            alternativeNames: domain.aliases,
            dns: domain.dns!,
          })
        : undefined;
    const certificateArn = domain && (domain.cert ?? certificate!.arn);
    const loadBalancer = this.part(
      "loadBalancer",
      {
        internal: output(balancer.public).apply((v) => !v),
        loadBalancerType: balancer.type,
        subnets: vpc.loadBalancerSubnets(balancer.public),
        securityGroups: [securityGroup.id],
        enableCrossZoneLoadBalancing: true,
      },
      // The load balancer is what holds on to the certificate, so it's
      // removed first. Its listeners are given the certificate, but it isn't.
      { dependsOn: certificate },
    );

    const targets = new Map<string, Target>();
    for (const rule of balancer.rules) {
      if (rule.type !== "forward") continue;
      const id = targetKey(
        rule.container,
        rule.forwardProtocol,
        rule.forwardPort,
      );
      if (targets.has(id)) continue;
      const protocol = rule.forwardProtocol.toUpperCase();
      targets.set(id, {
        container: rule.container,
        port: rule.forwardPort,
        group: this.part("target", id, {
          // AWS enforces a 6-char limit on namePrefix for target groups.
          // "TCP_UDP" is 7 chars, so strip the underscore to fit.
          namePrefix: protocol.replace("_", ""),
          port: rule.forwardPort,
          protocol,
          targetType: "ip",
          vpcId: vpc.id,
          healthCheck:
            balancer.health[`${rule.forwardPort}/${rule.forwardProtocol}`],
        }),
      });
    }

    // Rules that listen on the same port are rules of one listener
    const routes: Routing["routes"] = [];
    const listeners = new Map<string, InlineRule[]>();
    for (const rule of balancer.rules) {
      const id = listenerKey(rule.listenProtocol, rule.listenPort);
      listeners.set(id, [...(listeners.get(id) ?? []), rule]);
    }
    const actions = (rule?: InlineRule) => {
      if (!rule) return forbidden();
      if (rule.type === "redirect")
        return [
          {
            type: "redirect",
            redirect: {
              port: rule.redirectPort.toString(),
              protocol: rule.redirectProtocol.toUpperCase(),
              statusCode: "HTTP_301",
            },
          },
        ];
      return [
        {
          type: "forward",
          targetGroupArn: targets.get(
            targetKey(rule.container, rule.forwardProtocol, rule.forwardPort),
          )!.group.arn,
        },
      ];
    };
    for (const [id, rules] of listeners) {
      const protocol = rules[0].listenProtocol.toUpperCase();
      const listener = this.part("listener", id, {
        loadBalancerArn: loadBalancer.arn,
        port: rules[0].listenPort,
        protocol,
        certificateArn: ["HTTPS", "TLS"].includes(protocol)
          ? certificateArn
          : undefined,
        // What a request that matches no conditions gets
        defaultActions: actions(rules.find((rule) => !rule.conditions)),
      });
      routes.push(listener);

      for (const rule of rules) {
        const conditions = rule.conditions;
        if (!conditions) continue;
        routes.push(
          this.part(
            "listenerRule",
            `${id}Rule${hashStringToPrettyString(
              JSON.stringify(conditions),
              4,
            )}`,
            {
              listenerArn: listener.arn,
              actions: actions(rule),
              conditions: [
                {
                  pathPattern: conditions.path
                    ? { values: [conditions.path] }
                    : undefined,
                  queryStrings: conditions.query,
                  httpHeader: conditions.header
                    ? {
                        httpHeaderName: conditions.header.name,
                        values: conditions.header.values,
                      }
                    : undefined,
                },
              ],
            },
          ),
        );
      }
    }

    if (domain) pointDomainAt(name, domain, loadBalancer, this.delegateOpts());

    return {
      arn: loadBalancer.arn,
      url: domain
        ? interpolate`https://${domain.name}/`
        : interpolate`http://${loadBalancer.dnsName}`,
      targets: [...targets.values()],
      routes,
    };
  }

  // A load balancer the service shares with others: an `Alb`. The service
  // adds a target group for each container port, and a listener rule for
  // each of its rules.
  private attachToAlb(balancer: SharedBalancer, vpc: Network): Routing {
    const name = this.componentName;
    const { alb } = balancer;
    // The load balancer has to be in the cluster's VPC. The target groups
    // are what's given the VPC, so they're what the check holds back.
    const vpcId = all([alb._vpc, vpc.id]).apply(([albVpcId, clusterVpcId]) => {
      if (albVpcId !== clusterVpcId)
        throw new VisibleError(
          `The ALB VPC "${albVpcId}" does not match the cluster VPC "${clusterVpcId}" in Service "${name}". The ALB and cluster must be in the same VPC.`,
        );
      return albVpcId;
    });

    const targets = new Map<string, Target>();
    const routes: Routing["routes"] = [];
    for (const rule of balancer.rules) {
      const [listenPort, listenProtocol] = portOf(rule.listen);
      const [forwardPort, forwardProtocol] = portOf(rule.forward);
      const protocol = forwardProtocol.toUpperCase();
      const id = targetKey(rule.key, protocol, forwardPort);
      const target = targets.get(id) ?? {
        container: rule.container,
        port: forwardPort,
        group: this.part("target", id, {
          namePrefix: protocol,
          port: forwardPort,
          protocol,
          targetType: "ip",
          vpcId,
          healthCheck: output(
            balancer.health[`${forwardPort}/${forwardProtocol}`],
          ).apply((health) => ({
            path: health?.path ?? "/",
            interval: health?.interval ? toSeconds(health.interval) : 30,
            timeout: health?.timeout ? toSeconds(health.timeout) : 5,
            healthyThreshold: health?.healthyThreshold ?? 5,
            unhealthyThreshold: health?.unhealthyThreshold ?? 2,
            matcher: health?.successCodes ?? "200",
          })),
        }),
      };
      targets.set(id, target);

      routes.push(
        this.part(
          "listenerRule",
          `${listenerKey(listenProtocol, listenPort)}P${rule.priority}`,
          {
            listenerArn: alb.getListener(listenProtocol, listenPort).arn,
            priority: rule.priority,
            actions: [{ type: "forward", targetGroupArn: target.group.arn }],
            conditions: [
              {
                pathPattern: rule.conditions.path
                  ? { values: [rule.conditions.path] }
                  : undefined,
                queryStrings: rule.conditions.query,
                httpHeader: rule.conditions.header
                  ? output(rule.conditions.header).apply((h) => ({
                      httpHeaderName: h.name,
                      values: h.values,
                    }))
                  : undefined,
              },
            ],
          },
        ),
      );
    }

    return {
      arn: alb.arn,
      url: interpolate`http://${alb.dnsName}`,
      targets: [...targets.values()],
      routes,
    };
  }

  // Registers the service's tasks in the cluster's Cloud Map namespace, which
  // gives the service its host name. An SST VPC always has a namespace. For
  // a VPC passed in by its ids, whether it has one is known once they are.
  private createCloudmapService(
    vpc: Network,
    registry: ServiceArgs["serviceRegistry"],
  ) {
    const name = this.componentName;
    const part = this.partHandle("cloudmapService");
    const create = (namespaceId: Input<string>) =>
      new servicediscovery.Service(
        ...transformPart<servicediscovery.ServiceArgs>(
          part.transform,
          part.name,
          {
            name: `${name}.${$app.stage}.${$app.name}`,
            namespaceId,
            forceDestroy: true,
            dnsConfig: {
              namespaceId,
              dnsRecords: [
                ...(registry ? [{ ttl: 60, type: "SRV" }] : []),
                { ttl: 60, type: "A" },
              ],
            },
          },
          part.opts,
        ),
      );

    const existing = part.existing as
      | servicediscovery.Service
      | Input<string>
      | undefined;
    const service: Output<servicediscovery.Service | undefined> =
      existing !== undefined
        ? output(
            existing instanceof servicediscovery.Service
              ? existing
              : servicediscovery.Service.get(part.name, existing, undefined, {
                  parent: this,
                }),
          )
        : vpc.isSstVpc
          ? output(create(vpc.cloudmapNamespaceId.apply((id) => id!)))
          : // Given the output, not the id it holds: the output is what says
            // the namespace has to be there, and is removed after
            vpc.cloudmapNamespaceId.apply((id) =>
              id
                ? create(vpc.cloudmapNamespaceId.apply((id) => id!))
                : undefined,
            );

    part.defer(() =>
      service.apply((service) => {
        if (!service)
          throw new VisibleError(
            `Cannot access "nodes.cloudmapService" for the "${name}" Service. Cloud Map is not configured for the cluster.`,
          );
        return service;
      }),
    );
    return service;
  }

  /**
   * The URL of the service.
   *
   * If `loadBalancer.domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated load balancer URL.
   */
  public get url() {
    if (!this.reach.url)
      throw new VisibleError(
        "Cannot access the URL because no public ports are exposed.",
      );
    return this.reach.url;
  }

  /**
   * The name of the Cloud Map service. This is useful for service discovery.
   */
  public get service() {
    // Made when it's read: it fails for a cluster with no Cloud Map namespace
    return this.reach.host.apply((host) => {
      if (!host)
        throw new VisibleError(
          `Cannot access the AWS Cloud Map service name for the "${this.componentName}" Service. Cloud Map is not configured for the cluster.`,
        );
      return host;
    });
  }

  /**
   * Linking a service gives the linked resource its `url`, when it has a load balancer,
   * and its `service` host name.
   */
  public link() {
    return {
      properties: {
        url: this.reach.url,
        service: this.reach.host,
      },
    };
  }
}

/** Where a service runs. */
/** A container port that traffic is sent to. */
type Target = { group: lb.TargetGroup; container: string; port: number };

/** What a load balancer gives the service, its own or one it shares. */
type Routing = {
  arn: Output<string>;
  url: Output<string>;
  targets: Target[];
  /** The listeners and listener rules that send traffic to the targets. */
  routes: (lb.Listener | lb.ListenerRule)[];
};

type InlineRule = ReturnType<typeof ruleOf>;
type OwnBalancer = ReturnType<typeof ownBalancer>;
type SharedBalancer = ReturnType<typeof sharedBalancer>;

// What the service is told about its load balancer, checked: one of its
// own, or an `Alb` it's attached to
function loadBalancerOf(
  name: string,
  given: ServiceArgs["loadBalancer"],
  containers: Container[],
) {
  const args = plain(given, `The "loadBalancer" of the "${name}" service`);
  if (!args) return undefined;
  return "instance" in args
    ? sharedBalancer(name, args, containers)
    : ownBalancer(name, args, containers);
}

function ownBalancer(
  name: string,
  args: ServiceLoadBalancerArgs,
  containers: Container[],
) {
  const of = `the load balancer of the "${name}" service`;
  notAnOption(args, "ports", `It's "rules" now, in ${of}.`);
  const given = plain(args.rules, `The "rules" of ${of}`);
  if (!given?.length)
    throw new VisibleError(
      `You must provide the ports to expose via "loadBalancer.rules".`,
    );
  const rules = given.map((rule, i) =>
    ruleOf(rule, `Rule ${i + 1} of ${of}`, containers),
  );

  // validate protocols are consistent
  const type = protocolType(rules[0].listenProtocol);
  if (rules.some((rule) => protocolType(rule.listenProtocol) !== type))
    throw new VisibleError(
      `Protocols must be either all http/https, or all tcp/udp/tcp_udp/tls.`,
    );

  // validate certificate exists for https/tls protocol
  for (const rule of rules)
    if (["https", "tls"].includes(rule.listenProtocol) && !args.domain)
      throw new VisibleError(
        `You must provide a custom domain for ${rule.listenProtocol.toUpperCase()} protocol.`,
      );

  const domain = domainOf(args.domain, of);

  const health = Object.fromEntries(
    Object.entries(plain(args.health, `The "health" of ${of}`) ?? {}).map(
      ([port, check]) => {
        if (
          !rules.find(
            (rule) =>
              rule.type === "forward" &&
              `${rule.forwardPort}/${rule.forwardProtocol}` === port,
          )
        )
          throw new VisibleError(
            `Cannot configure health check for "${port}". Make sure it is defined in "loadBalancer.rules".`,
          );
        const http = protocolType(portOf(port)[1]) === "application";
        return [
          port,
          output(check).apply((check) => ({
            path: http ? check?.path ?? "/" : undefined,
            interval: check?.interval ? toSeconds(check.interval) : 30,
            timeout: check?.timeout
              ? toSeconds(check.timeout)
              : type === "application"
                ? 5
                : 6,
            healthyThreshold: check?.healthyThreshold ?? 5,
            unhealthyThreshold: check?.unhealthyThreshold ?? 2,
            protocol: http ? undefined : "TCP",
            matcher: http ? check?.successCodes ?? "200" : undefined,
          })),
        ];
      },
    ),
  );

  return {
    type,
    public: withDefault(args.public, true),
    domain,
    rules,
    health,
  };
}

// A rule of the service's own load balancer: where it listens, and whether
// it forwards to a container or redirects
function ruleOf(rule: ServiceRuleArgs, what: string, containers: Container[]) {
  // A rule decides a listener, a target group and a listener rule, and the
  // listener rule is named after its conditions
  plainDeep(rule, what);
  notAnOption(rule, "path", `It's "conditions: { path }" now.`);
  const [listenPort, listenProtocol] = portOf(rule.listen);
  const listen = {
    listenPort,
    listenProtocol,
    // The same three, in the same order, whatever was written: the listener
    // rule's name is made from them
    conditions: rule.conditions && {
      path: rule.conditions.path,
      query: rule.conditions.query,
      header: rule.conditions.header,
    },
  };
  if (protocolType(listenProtocol) === "network" && listen.conditions)
    throw new VisibleError(
      `Invalid rule conditions for listen protocol "${rule.listen}". Only "http" protocols support conditions.`,
    );

  if (rule.redirect) {
    const [redirectPort, redirectProtocol] = portOf(rule.redirect);
    if (protocolType(listenProtocol) !== protocolType(redirectProtocol))
      throw new VisibleError(
        `The listen protocol "${rule.listen}" must match the redirect protocol "${rule.redirect}".`,
      );
    return {
      type: "redirect" as const,
      ...listen,
      redirectPort,
      redirectProtocol,
    };
  }

  const container = containerOf(rule, what, containers);
  const [forwardPort, forwardProtocol] = portOf(rule.forward ?? rule.listen);
  if (protocolType(listenProtocol) !== protocolType(forwardProtocol))
    throw new VisibleError(
      `The listen protocol "${rule.listen}" must match the forward protocol "${rule.forward}".`,
    );
  return {
    type: "forward" as const,
    ...listen,
    forwardPort,
    forwardProtocol,
    container,
  };
}

// The container a rule forwards to: the one it names, or the only one
function containerOf(
  rule: { container?: string },
  what: string,
  containers: Container[],
) {
  const names = containers.map((container) => container.name);
  if (!rule.container) {
    if (names.length > 1)
      throw new VisibleError(
        `${what} has to name the "container" it forwards to. There's more than one: ${names.join(
          ", ",
        )}.`,
      );
    return names[0];
  }
  if (!names.includes(rule.container))
    throw new VisibleError(
      `${what} forwards to the container "${
        rule.container
      }", which isn't one of the service's: ${names.join(", ")}.`,
    );
  return rule.container;
}

function sharedBalancer(
  name: string,
  args: ServiceAlbArgs,
  containers: Container[],
) {
  if (!(args.instance instanceof OriginalAlb || args.instance instanceof Alb))
    throw new VisibleError(
      `The "loadBalancer.instance" of the "${name}" service has to be an "Alb".`,
    );
  const rules = plain(
    args.rules,
    `The "rules" of the load balancer of the "${name}" service`,
  );
  if (!rules?.length)
    throw new VisibleError(
      `You must provide at least one rule in "loadBalancer.rules" when using an external ALB in Service "${name}".`,
    );

  const of = `the load balancer of the "${name}" service`;
  const priorities = new Map<string, Set<number>>();
  const forwards = rules.map((rule, i) => {
    const container = containerOf(rule, `Rule ${i + 1} of ${of}`, containers);

    if (!(rule.priority >= 1 && rule.priority <= 50000))
      throw new VisibleError(
        `Priority ${rule.priority} must be between 1 and 50000 in Service "${name}". When sharing an ALB, ensure non-overlapping priority ranges across services.`,
      );
    const taken = priorities.get(rule.listen) ?? new Set();
    if (taken.has(rule.priority))
      throw new VisibleError(
        `Duplicate priority ${rule.priority} on listener "${rule.listen}" in Service "${name}".`,
      );
    priorities.set(rule.listen, taken.add(rule.priority));

    if (
      !rule.conditions?.path &&
      !rule.conditions?.query &&
      !rule.conditions?.header
    )
      throw new VisibleError(
        `At least one condition (path, query, or header) must be set for rules on an external ALB in Service "${name}".`,
      );
    // A rule that doesn't name its container has a target group named
    // after the service
    return { ...rule, container, key: rule.container ?? name };
  });

  return {
    // An `Alb` is an application load balancer
    type: "application" as const,
    alb: args.instance,
    rules: forwards,
    health: (plain(args.health, `The "health" of ${of}`) ?? {}) as Record<
      string,
      Input<ServiceHealthCheckArgs> | undefined
    >,
  };
}

// How the service scales. Which metrics it tracks decides which policies
// are created.
function scalingOf(
  name: string,
  given: ServiceArgs["scaling"],
  balancer: ReturnType<typeof loadBalancerOf>,
) {
  const scaling = plain(given, `The "scaling" of the "${name}" service`) ?? {};
  const target = (
    metric: "cpuUtilization" | "memoryUtilization" | "requestCount",
  ) =>
    plain(scaling[metric], `The "scaling.${metric}" of the "${name}" service`);

  const requestCount = target("requestCount") ?? false;
  if (requestCount && balancer?.type !== "application")
    throw new VisibleError(
      `Request count scaling is only supported for http/https protocols.`,
    );

  return {
    min: withDefault(scaling.min, 1),
    max: withDefault(scaling.max, 1),
    cpuUtilization: target("cpuUtilization") ?? 70,
    memoryUtilization: target("memoryUtilization") ?? 70,
    requestCount,
    scaleInCooldown: ifSet(scaling.scaleInCooldown, toSeconds),
    scaleOutCooldown: ifSet(scaling.scaleOutCooldown, toSeconds),
  };
}

// How the service's tasks are split between Fargate and Fargate Spot
function capacityStrategies(
  capacity: Exclude<$util.Unwrap<ServiceArgs["capacity"]>, undefined>,
) {
  const { fargate, spot }: Exclude<typeof capacity, "spot"> =
    capacity === "spot"
      ? { spot: { weight: 1 }, fargate: { weight: 0 } }
      : capacity;
  const strategy = (capacityProvider: string, share: typeof fargate) =>
    share ? [{ capacityProvider, base: share.base, weight: share.weight }] : [];
  return [...strategy("FARGATE", fargate), ...strategy("FARGATE_SPOT", spot)];
}

// "8080/http" as the port and the protocol
function portOf(port: string): [number, string] {
  const [number, protocol] = port.split("/");
  return [parseInt(number), protocol];
}

function protocolType(protocol: string) {
  return ["http", "https"].includes(protocol)
    ? ("application" as const)
    : ("network" as const);
}
