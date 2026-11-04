import {
  all,
  ComponentResourceOptions,
  interpolate,
  type Output,
  output,
  type Unwrap,
} from "@pulumi/pulumi";
import { appautoscaling, ec2, ecs, lb, servicediscovery } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
  optional,
} from "../../parts-component";
import {
  ifSet,
  notAnExistingPart,
  notAnOption,
  onlyExisting,
  plain,
  plainDeep,
  usedAsItIs,
  withDefault,
} from "../../args";
import { type DurationMinutes, toSeconds } from "../../duration";
import { VisibleError } from "../../error";
import { DevCommand } from "../../experimental/v5/dev-command";
import type { Input } from "../../input";
import { hashStringToPrettyString } from "../../naming";
import { transformPart } from "../../transform";
import { context } from "../../contract";
import { type AnyAlb, isAlb } from "../helpers/alb";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import {
  type Container,
  type ContainerArgs,
  type FargateBaseArgs,
  type ServiceDev,
  type ServiceHealth,
  createTaskDefinition,
  fargateTaskOf,
  fargateTaskParts,
  givenTaskDefinition,
  type Network,
  taskRoleArgs,
} from "../helpers/fargate";
import { listenerKey, targetKey } from "../helpers/load-balancer";
import {
  certificateOf,
  forbidden,
  type LoadBalancerDomainArgs,
  loadBalancerDomain,
  pointDomainAt,
  securityGroupArgs,
} from "../helpers/load-balancer-args";
import { URL_UNAVAILABLE } from "../linkable";

const parts = () => ({
  ...fargateTaskParts,
  /**
   * The Amazon ECS Task Definition. Not created when an existing `service` is given: that
   * one runs its own.
   */
  taskDefinition: optional(ecs.TaskDefinition),
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
   *
   * Not created when an existing `service` is given: pass the one that service is
   * registered in, in `existing`, for its host name.
   */
  cloudmapService: deferred(servicediscovery.Service),
  /**
   * The Amazon ECS Service. Given an existing one, the component creates nothing else: it
   * runs its own task definition, behind its own load balancer, and scales its own way.
   */
  service: ecs.Service,
  /**
   * The AWS Application Auto Scaling target. Not created when an existing `service` is
   * given.
   */
  autoScalingTarget: optional(appautoscaling.Target),
  /**
   * The AWS Application Auto Scaling policy that tracks CPU utilization. Not created
   * when `scaling.cpuUtilization` is `false`, or when an existing `service` is given.
   */
  autoScalingCpuPolicy: optional(appautoscaling.Policy),
  /**
   * The AWS Application Auto Scaling policy that tracks memory utilization. Not
   * created when `scaling.memoryUtilization` is `false`, or when an existing `service`
   * is given.
   */
  autoScalingMemoryPolicy: optional(appautoscaling.Policy),
  /**
   * The AWS Application Auto Scaling policy that tracks the requests each target
   * gets. Only created when `scaling.requestCount` is set.
   */
  autoScalingRequestCountPolicy: optional(appautoscaling.Policy),
  /**
   * What `sst dev` runs in place of each container that has a `dev.command`, by the
   * container's name.
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
  health?: ServiceHealth;
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

export interface ServiceDomainArgs extends LoadBalancerDomainArgs {}

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
  instance: AnyAlb;
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
  extends ComponentArgs<typeof parts>,
    FargateBaseArgs {
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
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your service is not deployed.
   * :::
   *
   * By default, your service in not deployed in `sst dev`. Instead, you can set the
   * `dev.command` and it'll be started locally in a separate tab in the
   * `sst dev` multiplexer. Read more about [`sst dev`](/docs/reference/cli/#dev).
   *
   * The command runs as the task role. So that the CLI can assume it, the task role trusts
   * your AWS account in `sst dev`. Any IAM user or role in the account whose policies allow
   * `sts:AssumeRole` on it can then assume it too.
   *
   * This makes it so that the container doesn't have to be redeployed on every change. To
   * disable this and deploy your service in `sst dev`, pass in `false`.
   *
   * It has to be a plain value: it decides whether the service is deployed.
   */
  dev?: ServiceDev;
  /**
   * Configure the CloudMap service registry for the service.
   *
   * This creates an `srv` record in the CloudMap service. This is needed if you want to connect
   * an `ApiGatewayHttp` VPC link to the service.
   *
   * API Gateway will forward requests to the given port on the service.
   *
   * @example
   * ```js
   * {
   *   serviceRegistry: {
   *     port: 80
   *   }
   * }
   * ```
   */
  serviceRegistry?: Input<{
    /**
     * The port in the service to forward requests to.
     */
    port: number;
  }>;
  /**
   * Configure the capacity provider; regular Fargate or Fargate Spot, for this service.
   *
   * :::tip
   * Fargate Spot is a good option for dev or PR environments.
   * :::
   *
   * Fargate Spot allows you to run containers on spare AWS capacity at around 50% discount
   * compared to regular Fargate. [Learn more about Fargate
   * pricing](https://aws.amazon.com/fargate/pricing/).
   *
   * :::note
   * AWS might shut down Fargate Spot instances to reclaim capacity.
   * :::
   *
   * There are a couple of caveats:
   *
   * 1. AWS may reclaim this capacity and **turn off your service** after a two-minute warning.
   *    This is rare, but it can happen.
   * 2. If there's no spare capacity, you'll **get an error**.
   *
   * This makes Fargate Spot a good option for dev or PR environments. You can set this using.
   *
   * ```js
   * {
   *   capacity: "spot"
   * }
   * ```
   *
   * You can also configure the % of regular vs spot capacity you want through the `weight` prop.
   * And optionally set the `base` or first X number of tasks that'll be started using a given
   * capacity.
   *
   * For example, the `base: 1` says that the first task uses regular Fargate, and from that
   * point on there will be an even split between the capacity providers.
   *
   * ```js
   * {
   *   capacity: {
   *     fargate: { weight: 1, base: 1 },
   *     spot: { weight: 1 }
   *   }
   * }
   * ```
   *
   * The `base` works in tandem with the `scaling` prop. So setting `base` to X doesn't mean
   * it'll start those tasks right away. It means that as your service scales up, according to
   * the `scaling` prop, it'll ensure that the first X tasks will be with the given capacity.
   *
   * :::caution
   * Changing `capacity` requires taking down and recreating the ECS service.
   * :::
   *
   * And this is why you can only set the `base` for only one capacity provider. So you
   * are not allowed to do the following.
   *
   * ```js
   * {
   *   capacity: {
   *     fargate: { weight: 1, base: 1 },
   *     // This will give you an error
   *     spot: { weight: 1, base: 1 }
   *   }
   * }
   * ```
   *
   * When you change the `capacity`, the ECS service is terminated and recreated. This will
   * cause some temporary downtime.
   *
   * @default Regular Fargate
   *
   * @example
   *
   * Here are some examples settings.
   *
   * - Use only Fargate Spot.
   *
   *   ```js
   *   {
   *     capacity: "spot"
   *   }
   *   ```
   * - Use 50% regular Fargate and 50% Fargate Spot.
   *
   *   ```js
   *   {
   *     capacity: {
   *       fargate: { weight: 1 },
   *       spot: { weight: 1 }
   *     }
   *   }
   *   ```
   * - Use 50% regular Fargate and 50% Fargate Spot. And ensure that the first 2 tasks use
   *   regular Fargate.
   *
   *   ```js
   *   {
   *     capacity: {
   *       fargate: { weight: 1, base: 2 },
   *       spot: { weight: 1 }
   *     }
   *   }
   *   ```
   */
  capacity?: Input<
    | "spot"
    | {
        /**
         * Configure how the regular Fargate capacity is allocated.
         */
        fargate?: Input<{
          /**
           * Start the first `base` number of tasks with the given capacity.
           *
           * :::caution
           * You can only specify `base` for one capacity provider.
           * :::
           */
          base?: Input<number>;
          /**
           * Ensure the given ratio of tasks are started for this capacity.
           */
          weight: Input<number>;
        }>;
        /**
         * Configure how the Fargate spot capacity is allocated.
         */
        spot?: Input<{
          /**
           * Start the first `base` number of tasks with the given capacity.
           *
           * :::caution
           * You can only specify `base` for one capacity provider.
           * :::
           */
          base?: Input<number>;
          /**
           * Ensure the given ratio of tasks are started for this capacity.
           */
          weight: Input<number>;
        }>;
      }
  >;
  /**
   * Configure the health check that ECS runs on your containers.
   *
   * :::tip
   * This health check is different from the [`loadBalancer.health`](#loadbalancer-health) check.
   * :::
   *
   * This health check is run by ECS. While, `loadBalancer.health` is run by the load balancer,
   * if you are using one. This is off by default. While the load balancer one
   * cannot be disabled.
   *
   * This config maps to the `HEALTHCHECK` parameter of the `docker run` command. Learn
   * more about [container health checks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_HealthCheck.html).
   *
   * @default Health check is disabled
   * @example
   * ```js
   * {
   *   health: {
   *     command: ["CMD-SHELL", "curl -f http://localhost:3000/ || exit 1"],
   *     startPeriod: "60 seconds",
   *     timeout: "5 seconds",
   *     interval: "30 seconds",
   *     retries: 3
   *   }
   * }
   * ```
   */
  health?: ServiceHealth;
  /**
   * Configure if `sst deploy` should wait for the service to be stable.
   *
   * :::tip
   * For non-prod environments it might make sense to pass in `false`.
   * :::
   *
   * Waiting for this process to finish ensures that new content will be available after
   * the deploy finishes. However, this process can sometimes take more than 5 mins.
   * @default `false`
   * @example
   * ```js
   * {
   *   wait: true
   * }
   * ```
   */
  wait?: Input<boolean>;
}

/**
 * The `Service` component lets you create containers that are always running, like web or
 * application servers. It uses [Amazon ECS](https://aws.amazon.com/ecs/) on [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html).
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a Service
 *
 * Services are run inside an ECS Cluster. If you haven't already, create one.
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.v5.Vpc("MyVpc");
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
 * const api = new sst.aws.v5.ApiGatewayHttp("MyApi", {
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
 * A role you pass is used as it is. What `link` grants isn't added to the task role, and
 * `permissions` next to it is refused: add them to the role itself. In `sst dev`, each
 * container's `dev.command` runs on your machine as the task role, so a task role you pass
 * has to trust your AWS account for it to.
 *
 * #### Run a task definition you already have
 *
 * Pass the task definition, or its ARN, and the service runs it the way it is.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   loadBalancer: {
 *     rules: [{ listen: "80/http", forward: "8080/http", container: "app" }]
 *   },
 *   existing: {
 *     taskDefinition: "arn:aws:ecs:us-east-1:123456789012:task-definition/my-app:3"
 *   }
 * });
 * ```
 *
 * The service then creates no roles, images or log groups: the task definition has its
 * containers, and what they run with. So the args that would make one, like `image`,
 * `containers`, `health`, `cpu`, `link` and `permissions`, are refused, and so are roles,
 * images and log groups in `existing`. A rule of the load balancer names the `container` it
 * forwards to, one of the task definition's. In `sst dev`, a `dev.command` runs as the task
 * definition's task role.
 *
 * #### Reference a service you already have
 *
 * Pass the ECS service, or its cluster's name and its own, and the component only
 * references it.
 *
 * ```ts title="sst.config.ts"
 * const service = new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   existing: {
 *     service: "my-cluster/my-service",
 *     cloudmapService: "srv-0123456789abcdef"
 *   }
 * });
 * ```
 *
 * It creates nothing, in `sst dev` too: the service runs its own task definition, behind
 * its own load balancer, and scales its own way. So every arg but the `cluster` is refused,
 * and `existing` takes only the Cloud Map service it's registered in, which gives it its
 * `service` host name. It has no `url`.
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
 * A few things work differently:
 *
 * - `taskRole: "my-task-role"` becomes `existing: { taskRole: "my-task-role" }`, and the
 *   same for `executionRole`.
 * - `public`, which `sst.aws.Service` deprecated, is `loadBalancer`. Its `ports` are
 *   `rules`, and a rule's `path` is `conditions.path`.
 * - `loadBalancer`, its `domain`, its `rules` and each rule are plain values, not outputs.
 *   So are `scaling` and its `cpuUtilization`, `memoryUtilization` and `requestCount`, the
 *   list of `containers`, each container and its `name`, and `dev`. They decide which
 *   resources are created. A rule on an `Alb` can have outputs in its `conditions`.
 * - A domain with `dns: false` and no `cert` is refused. There's nothing to validate a
 *   certificate with.
 * - With `containers`, the top-level `image`, `command`, `entrypoint`, `logging`,
 *   `environment`, `environmentFiles`, `volumes`, `ssm` and `health`, and `dev.command`,
 *   `dev.autostart` and `dev.directory`, are refused: set them on each container.
 *   `sst.aws.Service` refused some of them and dropped the others.
 * - A container's own `environmentFiles` are granted to the execution role, which
 *   `sst.aws.Service` left out. A service whose containers have them gets its execution
 *   role updated in place when you switch.
 * - `permissions` next to a `taskRole` in `existing` are refused. `sst.aws.Service` left
 *   them out of the role it was given.
 * - A `loadBalancer.health` check on an `Alb` for a port no rule forwards to is refused.
 *   `sst.aws.Service` dropped it.
 * - A `cpu`, `memory` or `storage` Fargate doesn't offer is refused as the config is read.
 * - A domain's `dns` is an adapter SST 5's components use, like `sst.aws.dns()`,
 *   `sst.cloudflare.dns()` or `sst.vercel.dns()`. An object written by hand for SST 4's
 *   doesn't work. The DNS records that validate its certificate are named after the
 *   domains they validate, and a domain's hosted zone is found without a resource: SST
 *   4's `HostedZoneLookup`, and Cloudflare's `ZoneLookup`, leave the state.
 * - `nodes.service` and `nodes.taskDefinition` are the resources, not outputs of them.
 *   `nodes` also has the log groups, images, listeners, target groups and scaling
 *   policies.
 * - `nodes.loadBalancer` is the load balancer the service creates. For a service that's
 *   attached to an `Alb`, read it from the `Alb`.
 * - `nodes.taskRole`, `nodes.executionRole`, `nodes.taskDefinition` and
 *   `nodes.autoScalingTarget` may be `undefined`: they aren't created for an ECS service or
 *   a task definition you pass in `existing`.
 * - A `transform` function for `service`, `taskDefinition`, `logGroup`, `target` or
 *   `listener` is given outputs where `sst.aws.Service` gave it plain values. For a part
 *   there are several of, it's also given which one.
 * - `transform.listenerRule` applies to the rules of the service's own load balancer too,
 *   not only to the rules on an `Alb`.
 * - `loadBalancer.instance` takes either `Alb`, and `cluster` either `Cluster`. Each
 *   refuses anything else.
 * - If you set part of the ECS service's `networkConfiguration` or
 *   `deploymentCircuitBreaker`, of a target group's `healthCheck`, or of the task
 *   definition's `runtimePlatform`, with an object in `transform`, the rest of it is kept.
 *
 * One thing changes on the first deploy, and nothing in AWS: what `sst dev` runs for each
 * container is kept inside the service now, so it's listed as removed and created again.
 * It's created only for a container with a `dev.command`: `sst dev` ran nothing for one
 * without.
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
    // Why there's no host name, when there isn't
    noHost: string;
  };

  constructor(
    name: string,
    args: ServiceArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const owner = `the "${name}" service`;
    const noNamespace = "the VPC of its cluster has no Cloud Map namespace";
    // An ECS service that's already deployed is only referenced. It runs its
    // own task definition, behind its own load balancer, and scales its own
    // way, so what would configure them is refused. The Cloud Map service it's
    // registered in is taken, for its host name.
    const givenService = args.existing?.service !== undefined;
    // A task definition that's already deployed is run the way it is
    const givenDefinition = args.existing?.taskDefinition !== undefined;
    if (givenService) {
      onlyExisting(args.existing, ["service", "cloudmapService"], owner);
      usedAsItIs(
        args,
        Object.keys(args).filter(
          (key) =>
            !["cluster", "transform", "existing"].includes(key) &&
            !(key === "dev" && args.dev === false),
        ),
        "service",
        owner,
      );
    } else if (givenDefinition) givenTaskDefinition(args, "service", owner);

    // In `sst dev` the service isn't deployed. Each container's command runs
    // on the user's machine, as the task role. One that's given is the one
    // that's deployed, in `sst dev` too.
    const dev =
      !givenService &&
      plain(args.dev, `The "dev" of the "${name}" service`) !== false &&
      context().dev;
    const task = fargateTaskOf(this.builder(), "service", name, args);
    notAnOption(
      args,
      "public",
      `It's "loadBalancer" now, with the same settings.`,
      owner,
    );

    const { cluster, containers, region } = task;
    const vpc = task.network;

    if (givenService) {
      // Looked up when it's given by its id, so it's in `nodes`
      this.existingPart("service");
      const registry =
        args.existing?.cloudmapService !== undefined
          ? this.createCloudmapService(vpc, undefined)
          : undefined;
      const noRegistry = `it's given an existing "service", and no "cloudmapService" with it`;
      if (!registry)
        this.partHandle("cloudmapService").defer(() => {
          throw new VisibleError(
            `The "${name}" service has no "nodes.cloudmapService": ${noRegistry}.`,
          );
        });
      this.reach = {
        host: registry ? hostOf(vpc, registry) : output(undefined),
        noHost: registry ? noNamespace : noRegistry,
      };
      return;
    }

    // The containers of a task definition that's given are its own
    const balancer = loadBalancerOf(
      name,
      args.loadBalancer,
      givenDefinition ? undefined : containers,
    );
    const scaling = scalingOf(name, args.scaling, balancer);

    // A part that isn't created for the args the service is given can't be
    // in `existing`: it wouldn't be used
    const notCreated = (keys: string[], instead: string) => {
      for (const key of keys)
        notAnExistingPart(args.existing, key, owner, instead);
    };
    const ownBalancerParts = [
      "loadBalancerSecurityGroup",
      "loadBalancer",
      "certificate",
      "listener",
    ];
    if (!balancer)
      notCreated(
        [...ownBalancerParts, "target", "listenerRule"],
        `It's only created with "loadBalancer".`,
      );
    else if ("alb" in balancer)
      notCreated(
        ownBalancerParts,
        `The service is attached to an "Alb", which has its own.`,
      );
    else if (!balancer.domain || balancer.domain.cert)
      notCreated(
        ["certificate"],
        balancer.domain
          ? `It uses the "cert" of the load balancer's "domain".`
          : `It's only created for the load balancer's "domain".`,
      );
    if (scaling.cpuUtilization === false)
      notCreated(
        ["autoScalingCpuPolicy"],
        `It's only created when "scaling.cpuUtilization" isn't false.`,
      );
    if (scaling.memoryUtilization === false)
      notCreated(
        ["autoScalingMemoryPolicy"],
        `It's only created when "scaling.memoryUtilization" isn't false.`,
      );
    if (scaling.requestCount === false)
      notCreated(
        ["autoScalingRequestCountPolicy"],
        `It's only created with "scaling.requestCount".`,
      );

    // The containers run as the task role, and so does what `sst dev` runs in
    // place of them. A task definition that's given has a role of its own.
    const definition = givenDefinition
      ? this.existingPart("taskDefinition")!
      : undefined;
    const taskRole = definition
      ? undefined
      : this.part("taskRole", taskRoleArgs(args, this, dev));
    // `sst dev` runs a command with no role with the user's own credentials
    const runsAs =
      taskRole?.arn ?? definition!.taskRoleArn.apply((arn) => arn ?? "");

    // What `sst dev` runs in place of each container with a dev command, in a
    // pane of its own. `sst dev` runs nothing for one without.
    let devCommands = 0;
    for (const container of containers) {
      const settings = plain(
        container.dev,
        `The "dev" of the "${container.name}" container of the "${name}" service`,
      );
      // An empty command too, as `sst dev` skipped it
      if (!settings || !settings.command) continue;
      devCommands++;
      this.part("devCommand", container.name, {
        link: args.link,
        dev: {
          command: settings.command,
          title: containers.length === 1 ? name : `${name}${container.name}`,
          autostart: settings.autostart,
          directory:
            settings.directory ??
            output(container.image).apply((image) =>
              typeof image === "string" ? "" : image?.context ?? ".",
            ),
        },
        environment: output(container.environment).apply((environment) => ({
          ...environment,
          AWS_REGION: region,
        })),
        aws: { role: runsAs },
      });
    }
    if (!devCommands)
      notCreated(
        ["devCommand"],
        `It's only created for a container with a "dev.command".`,
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
        noHost: noNamespace,
      };
      return;
    }

    const taskDefinition =
      definition ??
      createTaskDefinition(
        this.builder(),
        name,
        task,
        args.link,
        containers,
        taskRole!,
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
      host: hostOf(vpc, cloudmapService),
      noHost: noNamespace,
    };

    this.report({ hint: this.reach.url });
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
      domain && certificateOf(domain, (args) => this.part("certificate", args));
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
      { dependsOn: certificate?.created },
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
          ? certificate?.arn
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
          `The "Alb" of the "${name}" service is in the VPC "${albVpcId}", and its cluster is in "${clusterVpcId}". Put them in the same VPC.`,
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
            name: `${name}.${context().app.stage}.${context().app.name}`,
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
            `The "${name}" service has no "nodes.cloudmapService": the VPC of its cluster has no Cloud Map namespace.`,
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
        `The "${this.componentName}" service has no "url": it has no "loadBalancer".`,
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
          `The "${this.componentName}" service has no Cloud Map "service" name: ${this.reach.noHost}.`,
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

/**
 * The host name of a service in the cluster's Cloud Map namespace, when it's
 * registered in one.
 */
function hostOf(
  vpc: Network,
  registry: Output<servicediscovery.Service | undefined>,
): Output<string | undefined> {
  return all([vpc.cloudmapNamespaceName, registry]).apply(
    ([namespace, registry]) =>
      namespace && registry
        ? registry.name.apply((service): string => `${service}.${namespace}`)
        : output(undefined),
  );
}

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
  containers: Container[] | undefined,
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
  containers: Container[] | undefined,
) {
  const of = `the load balancer of the "${name}" service`;
  notAnOption(args, "ports", `It's "rules" now.`, of);
  const given = plain(args.rules, `The "rules" of ${of}`);
  if (!given?.length)
    throw new VisibleError(
      `The load balancer of the "${name}" service has no "rules". Give it at least one.`,
    );
  const rules = given.map((rule, i) =>
    ruleOf(rule, `Rule ${i + 1} of ${of}`, containers),
  );

  // One load balancer is either an application or a network one
  const type = protocolType(rules[0].listenProtocol);
  if (rules.some((rule) => protocolType(rule.listenProtocol) !== type))
    throw new VisibleError(
      `The "rules" of ${of} listen on http or https and on tcp, udp, tcp_udp or tls. Use one kind or the other.`,
    );

  // An https or tls listener needs the domain's certificate
  for (const rule of rules)
    if (["https", "tls"].includes(rule.listenProtocol) && !args.domain)
      throw new VisibleError(
        `A rule of ${of} listens on ${rule.listenProtocol}, which needs a certificate. Set the "domain" of the load balancer.`,
      );

  const domain = loadBalancerDomain(args.domain, of);

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
            `The "health" of ${of} has "${port}", which no rule forwards to. Forward to it in "rules", or remove it.`,
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
function ruleOf(
  rule: ServiceRuleArgs,
  what: string,
  containers: Container[] | undefined,
) {
  // A rule decides a listener, a target group and a listener rule, and the
  // listener rule is named after its conditions
  plainDeep(rule, what);
  notAnOption(
    rule,
    "path",
    `It's "conditions: { path }" now.`,
    `${what[0].toLowerCase()}${what.slice(1)}`,
  );
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
      `${what} listens on "${rule.listen}" and has "conditions". Only a rule that listens on http or https takes them.`,
    );

  if (rule.redirect) {
    const [redirectPort, redirectProtocol] = portOf(rule.redirect);
    if (protocolType(listenProtocol) !== protocolType(redirectProtocol))
      throw new VisibleError(
        `${what} listens on "${rule.listen}" and redirects to "${rule.redirect}". Both have to be http or https, or both tcp, udp, tcp_udp or tls.`,
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
      `${what} listens on "${rule.listen}" and forwards to "${rule.forward}". Both have to be http or https, or both tcp, udp, tcp_udp or tls.`,
    );
  return {
    type: "forward" as const,
    ...listen,
    forwardPort,
    forwardProtocol,
    container,
  };
}

// The container a rule forwards to: the one it names, or the only one. The
// containers of a task definition that's given aren't known: a rule names
// one of them.
function containerOf(
  rule: { container?: string },
  what: string,
  containers: Container[] | undefined,
) {
  if (!containers) {
    if (!rule.container)
      throw new VisibleError(
        `${what} has to name the "container" it forwards to, one of the containers of the existing "taskDefinition" the service is given.`,
      );
    return rule.container;
  }
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
  containers: Container[] | undefined,
) {
  const of = `the load balancer of the "${name}" service`;
  if (!isAlb(args.instance))
    throw new VisibleError(
      `The "loadBalancer.instance" of the "${name}" service has to be an "Alb".`,
    );
  const rules = plain(args.rules, `The "rules" of ${of}`);
  if (!rules?.length)
    throw new VisibleError(
      `The load balancer of the "${name}" service has no "rules". Give it at least one.`,
    );

  const priorities = new Map<string, Set<number>>();
  const forwards = rules.map((given, i) => {
    const what = `Rule ${i + 1} of ${of}`;
    // A rule decides a target group and a listener rule, named after where
    // it listens, its priority, and where it forwards to. Its conditions can
    // be outputs.
    const rule = plain(given, what);
    plainDeep(
      {
        listen: rule.listen,
        forward: rule.forward,
        container: rule.container,
        priority: rule.priority,
      },
      what,
    );
    plain(rule.conditions, `The "conditions" of ${what}`);
    const container = containerOf(rule, what, containers);

    if (!(rule.priority >= 1 && rule.priority <= 50000))
      throw new VisibleError(
        `The "priority" of rule ${i + 1} of ${of} is ${
          rule.priority
        }. It has to be between 1 and 50000, and the services on an "Alb" each need their own range.`,
      );
    const taken = priorities.get(rule.listen) ?? new Set();
    if (taken.has(rule.priority))
      throw new VisibleError(
        `${what} has the priority ${rule.priority} on "${rule.listen}", which another of its rules has. Give each its own.`,
      );
    priorities.set(rule.listen, taken.add(rule.priority));

    if (
      !rule.conditions?.path &&
      !rule.conditions?.query &&
      !rule.conditions?.header
    )
      throw new VisibleError(
        `${what} has no "conditions". A rule on an "Alb" needs a path, a query or a header: the "Alb" answers what no rule matches.`,
      );
    // A rule that doesn't name its container has a target group named
    // after the service
    return { ...rule, container, key: rule.container ?? name };
  });

  // A health check is for a port a rule forwards to
  const health = (plain(args.health, `The "health" of ${of}`) ?? {}) as Record<
    string,
    Input<ServiceHealthCheckArgs> | undefined
  >;
  for (const port of Object.keys(health))
    if (!forwards.some((rule) => rule.forward === port))
      throw new VisibleError(
        `The "health" of ${of} has "${port}", which no rule forwards to. Forward to it in "rules", or remove it.`,
      );

  return {
    // An `Alb` is an application load balancer
    type: "application" as const,
    alb: args.instance,
    rules: forwards,
    health,
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
      `The "scaling.requestCount" of the "${name}" service needs a load balancer with http or https rules.`,
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
  capacity: Exclude<Unwrap<ServiceArgs["capacity"]>, undefined>,
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
