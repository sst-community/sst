import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as aws from "@pulumi/aws";
import * as cloudflare from "@pulumi/cloudflare";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi();

type Base = typeof import("../../src/components/component");
type PartialArgs<T> = import("../../src/components/transform").PartialArgs<T>;
type Module = typeof import("../../src/components/parts-component");

describe("Component parts", () => {
  let Component: Base["Component"];
  let mergeArgs: Base["mergeArgs"];
  let component: Module["component"];
  let deferred: Module["deferred"];
  let many: Module["many"];
  let named: Module["named"];
  let optional: Module["optional"];

  beforeAll(async () => {
    ({ Component, mergeArgs } = await import("../../src/components/component"));
    ({ component, deferred, many, named, optional } = await import(
      "../../src/components/parts-component"
    ));
  });

  beforeEach(() => pulumi.reset());

  // A component written the way a user would write one, mixing AWS and
  // Cloudflare resources.
  function defineUploads() {
    const parts = {
      bucket: aws.s3.Bucket,
      mirror: cloudflare.R2Bucket,
      alias: aws.kms.Alias,
    };
    type Args = {
      transform?: import("../../src/components/parts-component").Transforms<
        typeof parts
      >;
    };
    return class Uploads extends component("acme:Uploads", parts) {
      constructor(name: string, args: Args = {}, opts = {}) {
        super(name, args, opts);
        this.part("bucket", {
          forceDestroy: true,
          tags: { team: "storage", tier: "standard" },
        });
        this.part("mirror", { accountId: "abc123", name: "" });
        this.part("alias", { targetKeyId: "key-1" });
      }
    };
  }

  it("names each part after the component and adds it to nodes", async () => {
    const Uploads = defineUploads();
    const uploads = new Uploads("Docs");
    await pulumi.settle();

    const names = pulumi.resources.map((r) => r.name).sort();
    expect(names).toEqual(["Docs", "DocsAlias", "DocsBucket", "DocsMirror"]);
    expect(uploads.nodes.bucket).toBeInstanceOf(aws.s3.Bucket);
    expect(uploads.nodes.mirror).toBeInstanceOf(cloudflare.R2Bucket);
    expect(Object.keys(uploads.nodes)).toEqual(["bucket", "mirror", "alias"]);
  });

  it("prefixes physical names for AWS and Cloudflare resources", async () => {
    const Uploads = defineUploads();
    new Uploads("Docs");
    await pulumi.settle();

    const bucket = pulumi.resources.find((r) => r.name === "DocsBucket")!;
    const mirror = pulumi.resources.find((r) => r.name === "DocsMirror")!;
    expect(bucket.inputs.bucket).toMatch(/^app-test-docsbucket-[a-z]{8}$/);
    expect(mirror.inputs.name).toMatch(/^app-test-docsmirror-[a-z]{8}$/);
  });

  it("leaves resource types it has no naming rule for to the provider", async () => {
    const Uploads = defineUploads();
    new Uploads("Docs");
    await pulumi.settle();

    const alias = pulumi.resources.find((r) => r.name === "DocsAlias")!;
    expect(alias.inputs.name).toBeUndefined();
  });

  it("uses a naming rule registered for a resource type", async () => {
    Component.naming("aws:kms/alias:Alias", {
      field: "name",
      max: 64,
      replace: (name) => `alias/${name}`,
    });
    const Uploads = defineUploads();
    new Uploads("Docs");
    await pulumi.settle();
    Component.naming("aws:kms/alias:Alias", false);

    const alias = pulumi.resources.find((r) => r.name === "DocsAlias")!;
    expect(alias.inputs.name).toMatch(/^alias\/app-test-DocsAlias-[a-z]{8}$/);
  });

  it("merges an object transform into nested defaults", async () => {
    const Uploads = defineUploads();
    new Uploads("Docs", {
      transform: { bucket: { tags: { tier: "archive" } } },
    });
    await pulumi.settle();

    const bucket = pulumi.resources.find((r) => r.name === "DocsBucket")!;
    expect(bucket.inputs.tags).toEqual({ team: "storage", tier: "archive" });
    expect(bucket.inputs.forceDestroy).toBe(true);
  });

  it("applies a function transform to args and options", async () => {
    const Uploads = defineUploads();
    new Uploads("Docs", {
      transform: {
        bucket: (args, opts) => {
          args.tags = { only: "this" };
          opts.protect = true;
        },
      },
    });
    await pulumi.settle();

    const bucket = pulumi.resources.find((r) => r.name === "DocsBucket")!;
    expect(bucket.inputs.tags).toEqual({ only: "this" });
    expect(bucket.options.protect).toBe(true);
  });

  it("rejects a transform for something the component doesn't have", () => {
    const Uploads = defineUploads();
    expect(
      () => new Uploads("Docs", { transform: { bukcet: {} } as any }),
    ).toThrow(/"bukcet" is not something you can transform.*bucket, mirror, alias/);
  });

  it("rejects a child resource that isn't a declared part", async () => {
    const parts = { bucket: aws.s3.Bucket };
    class Leaky extends component("acme:Leaky", parts) {
      constructor(name: string) {
        super(name);
        this.part("bucket", {});
        new aws.sqs.Queue(`${name}Extra`, {}, { parent: this });
      }
    }
    expect(() => new Leaky("Docs")).toThrow(
      /"DocsExtra" \(aws:sqs\/queue:Queue\) is not one of the component's parts/,
    );
    await pulumi.settle();
  });

  it("says when a part is created a second time", async () => {
    const parts = { bucket: aws.s3.Bucket };
    class Twice extends component("acme:Twice", parts) {
      constructor(name: string) {
        super(name);
        this.part("bucket", {});
      }
      again() {
        this.part("bucket", {});
      }
    }
    const twice = new Twice("Docs");
    expect(() => twice.again()).toThrow(
      /"Docs" component has already created its "bucket"/,
    );
    await pulumi.settle();
  });

  // SST's own provider resources add their type to the name they're given:
  // "DocsKeys.sst.aws.KvKeys"
  it("takes one of SST's provider resources as a part", async () => {
    const { KvKeys } = await import(
      "../../src/components/aws/providers/kv-keys"
    );
    const parts = { keys: KvKeys };
    class Routed extends component("acme:Routed", parts) {
      constructor(name: string, args: object) {
        super(name, args);
        this.part("keys", {
          store: "arn:store",
          namespace: "ns",
          entries: {},
          purge: false,
        });
      }
    }
    const routed = new Routed("Docs", {
      transform: { keys: { purge: true } },
    });
    await pulumi.settle();

    expect(routed.nodes.keys).toBeInstanceOf(KvKeys);
    const keys = pulumi.resources.find((r) => r.name.startsWith("DocsKeys"))!;
    expect(keys.name).toBe("DocsKeys.sst.aws.KvKeys");
    expect(keys.inputs.purge).toBe(true);
  });

  it("adds a part to nodes when it's created later", async () => {
    const parts = { bucket: aws.s3.Bucket, grant: optional(aws.sqs.Queue) };
    class Late extends component("acme:Late", parts) {
      constructor(name: string) {
        super(name);
        // Whether there's a grant depends on something only known on deploy
        this.part("bucket", {}).arn.apply(() => this.part("grant", {}));
      }
    }
    const late = new Late("Docs");
    expect(late.nodes.grant).toBeUndefined();
    await pulumi.settle();
    expect(late.nodes.grant).toBeInstanceOf(aws.sqs.Queue);
  });

  it("lets something else create resources that aren't parts", async () => {
    const parts = { bucket: aws.s3.Bucket };
    // Stands in for an adapter, like the ones that create DNS records
    const adapter = (name: string, opts: object) =>
      new aws.sqs.Queue(`${name}Extra`, {}, opts);
    class Delegating extends component("acme:Delegating", parts) {
      constructor(name: string) {
        super(name);
        this.part("bucket", {});
        adapter(name, this.delegateOpts());
      }
    }
    const delegating = new Delegating("Docs");
    await pulumi.settle();

    const extra = pulumi.resources.find((r) => r.name === "DocsExtra")!;
    expect(extra.parent).toMatch(/::Docs$/);
    expect(Object.keys(delegating.nodes)).toEqual(["bucket"]);
  });

  it("keeps naming when the user passes their own transformations", async () => {
    const Uploads = defineUploads();
    const seen: string[] = [];
    new Uploads(
      "Docs",
      {},
      {
        transformations: [
          (args: any) => {
            seen.push(args.name);
            return undefined;
          },
        ],
      },
    );
    await pulumi.settle();

    const bucket = pulumi.resources.find((r) => r.name === "DocsBucket")!;
    expect(bucket.inputs.bucket).toMatch(/^app-test-docsbucket-/);
    expect(seen).toContain("DocsBucket");
  });

  it("applies $transform before the component reads its args", async () => {
    const { $transform } = await import("../../src/components/component");
    const parts = { bucket: aws.s3.Bucket };
    type Args = import("../../src/components/parts-component").ComponentArgs<
      typeof parts
    >;
    class Archive extends component("acme:Archive", parts) {
      constructor(name: string, args: Args) {
        super(name, args);
        this.part("bucket", { forceDestroy: true });
      }
    }
    $transform(Archive, (args) => {
      args.transform = { bucket: { forceDestroy: false } };
    });
    new Archive("Docs", {});
    await pulumi.settle();

    const bucket = pulumi.resources.find((r) => r.name === "DocsBucket")!;
    expect(bucket.inputs.forceDestroy).toBe(false);
  });

  // What `functionPart()` does for a function, done here for a bucket
  it("exposes a deferred part as an output", async () => {
    const parts = {
      bucket: deferred(aws.s3.Bucket),
    };
    class Later extends component("acme:Later", parts) {
      constructor(name: string) {
        super(name);
        // @ts-expect-error A deferred part isn't created with `part()`
        (): unknown => this.part("bucket", {});
        const part = this.partHandle("bucket");
        const bucket = output("ready").apply(
          () => new aws.s3.Bucket(part.name, {}, part.opts),
        );
        part.defer(() => bucket);
      }
    }
    const later = new Later("Docs");
    const bucket = await pulumi.resolve(later.nodes.bucket);
    await pulumi.settle();
    expect(bucket).toBeInstanceOf(aws.s3.Bucket);
  });

  describe("many parts", () => {
    function defineNetwork() {
      const parts = {
        vpc: aws.ec2.Vpc,
        subnet: many(aws.ec2.Subnet),
      };
      type Args = {
        zones: string[];
        transform?: import("../../src/components/parts-component").Transforms<
          typeof parts
        >;
      };
      return class Network extends component("acme:Network", parts) {
        constructor(name: string, args: Args) {
          super(name, args);
          const vpc = this.part("vpc", { cidrBlock: "10.0.0.0/16" });
          args.zones.forEach((zone, i) =>
            this.part("subnet", zone, {
              vpcId: vpc.id,
              availabilityZone: zone,
              cidrBlock: `10.0.${i}.0/24`,
            }),
          );
        }
      };
    }

    it("names each one with its id and holds them by id in nodes", async () => {
      const Network = defineNetwork();
      const network = new Network("Net", { zones: ["us-east-1a", "us-east-1b"] });
      await pulumi.settle();

      const names = pulumi.resources.map((r) => r.name).sort();
      expect(names).toEqual([
        "Net",
        "NetSubnetUseast1a",
        "NetSubnetUseast1b",
        "NetVpc",
      ]);
      expect(Object.keys(network.nodes.subnet)).toEqual([
        "us-east-1a",
        "us-east-1b",
      ]);
      expect(network.nodes.subnet["us-east-1a"]).toBeInstanceOf(aws.ec2.Subnet);
    });

    it("applies an object transform to every one", async () => {
      const Network = defineNetwork();
      new Network("Net", {
        zones: ["us-east-1a", "us-east-1b"],
        transform: { subnet: { mapPublicIpOnLaunch: true } },
      });
      await pulumi.settle();

      const subnets = pulumi.resources.filter((r) => r.name.includes("Subnet"));
      expect(subnets.map((s) => s.inputs.mapPublicIpOnLaunch)).toEqual([
        true,
        true,
      ]);
    });

    it("tells a function transform which one it is given", async () => {
      const Network = defineNetwork();
      new Network("Net", {
        zones: ["us-east-1a", "us-east-1b"],
        transform: {
          subnet: (args, _opts, _name, id) => {
            if (id === "us-east-1b") args.mapPublicIpOnLaunch = true;
          },
        },
      });
      await pulumi.settle();

      const a = pulumi.resources.find((r) => r.name === "NetSubnetUseast1a")!;
      const b = pulumi.resources.find((r) => r.name === "NetSubnetUseast1b")!;
      expect(a.inputs.mapPublicIpOnLaunch).toBeUndefined();
      expect(b.inputs.mapPublicIpOnLaunch).toBe(true);
    });

    it("accepts one created without part(), matching it by name", async () => {
      const parts = { subnet: many(aws.ec2.Subnet) };
      class Loose extends component("acme:Loose", parts) {
        constructor(name: string) {
          super(name);
          new aws.ec2.Subnet(
            `${name}Subnet7`,
            { vpcId: "vpc-1", cidrBlock: "10.0.7.0/24" },
            { parent: this },
          );
        }
      }
      const loose = new Loose("Net");
      await pulumi.settle();
      expect(Object.keys(loose.nodes.subnet)).toEqual(["7"]);
    });

    it("takes any string as an id, and names it apart from similar ones", async () => {
      const parts = { subnet: many(aws.ec2.Subnet) };
      class Zones extends component("acme:Zones", parts) {
        constructor(name: string, ids: string[]) {
          super(name);
          for (const id of ids) this.part("subnet", id, { vpcId: "vpc-1" });
        }
      }
      const zones = new Zones("Net", ["a/b", "a b", "toString", "plain-id"]);
      await pulumi.settle();

      const names = pulumi.resources.map((r) => r.name);
      expect(names[1]).toMatch(/^NetSubnetAb[A-Z][a-z]{5}$/);
      expect(names[2]).toMatch(/^NetSubnetAb[A-Z][a-z]{5}$/);
      expect(names[1]).not.toBe(names[2]);
      expect(names.slice(3)).toEqual(["NetSubnetToString", "NetSubnetPlainid"]);
      expect(Object.keys(zones.nodes.subnet)).toEqual([
        "a/b",
        "a b",
        "toString",
        "plain-id",
      ]);
      expect("constructor" in zones.nodes.subnet).toBe(false);
    });

    it("says when two ids would get the same name", () => {
      const parts = { subnet: many(aws.ec2.Subnet) };
      class Alike extends component("acme:Alike", parts) {
        constructor(name: string) {
          super(name);
          this.part("subnet", "get-user", { vpcId: "vpc-1" });
          this.part("subnet", "getuser", { vpcId: "vpc-1" });
        }
      }
      expect(() => new Alike("Net")).toThrow(
        /"get-user" and "getuser" are too alike: both would be named "NetSubnetGetuser"/,
      );
    });

    it("requires an id", () => {
      const parts = { subnet: many(aws.ec2.Subnet) };
      class NoId extends component("acme:NoId", parts) {
        constructor(name: string) {
          super(name);
          this.part("subnet", "--", { vpcId: "vpc-1" });
        }
      }
      expect(() => new NoId("Net")).toThrow(/each one needs an id/);
    });
  });

  describe("optional parts and existing resources", () => {
    function defineInbox() {
      const parts = {
        queue: aws.sqs.Queue,
        deadLetters: optional(aws.sqs.Queue),
        alarm: many(aws.cloudwatch.MetricAlarm),
      };
      type Args = import("../../src/components/parts-component").ComponentArgs<
        typeof parts
      > & { deadLetters?: boolean; alarms?: string[] };
      return class Inbox extends component("acme:Inbox", parts) {
        constructor(name: string, args: Args = {}) {
          super(name, args);
          const dlq = args.deadLetters
            ? this.part("deadLetters", {})
            : undefined;
          this.part("queue", { redrivePolicy: dlq?.arn });
          for (const id of args.alarms ?? [])
            this.part("alarm", id, {
              comparisonOperator: "GreaterThanThreshold",
              evaluationPeriods: 1,
            });
        }
      };
    }

    it("leaves an optional part out of nodes when it isn't created", async () => {
      const Inbox = defineInbox();
      const without = new Inbox("A");
      const withDlq = new Inbox("B", { deadLetters: true });
      await pulumi.settle();

      expect(without.nodes.deadLetters).toBeUndefined();
      expect(withDlq.nodes.deadLetters).toBeInstanceOf(aws.sqs.Queue);
    });

    it("uses an existing resource in place of creating one", async () => {
      const mine = new aws.sqs.Queue("Mine", {});
      await pulumi.settle();
      pulumi.reset();

      const Inbox = defineInbox();
      const inbox = new Inbox("A", { existing: { queue: mine } });
      await pulumi.settle();

      expect(inbox.nodes.queue).toBe(mine);
      expect(pulumi.resources.map((r) => r.name)).toEqual(["A"]);
    });

    it("looks up an existing resource by id", async () => {
      const Inbox = defineInbox();
      const inbox = new Inbox("A", {
        existing: { queue: "https://sqs.example.com/123/mine" },
      });
      await pulumi.settle();

      const read = pulumi.resources.find((r) => r.kind === "read")!;
      expect(read.name).toBe("AQueue");
      expect(read.options.id).toBe("https://sqs.example.com/123/mine");
      // It isn't given a generated name: it has the name it has
      expect(read.inputs.name).toBeUndefined();
      expect(inbox.nodes.queue).toBeInstanceOf(aws.sqs.Queue);
      expect(pulumi.resources.filter((r) => r.kind === "register").length).toBe(1);
    });

    // A component that references something already deployed finds the ids
    // of its other parts itself: here, from the queue it's given.
    it("looks a part up by an id the component works out", async () => {
      const parts = {
        queue: aws.sqs.Queue,
        deadLetters: optional(aws.sqs.Queue),
        alarm: many(aws.cloudwatch.MetricAlarm),
      };
      class Inbox extends component("acme:Inbox", parts) {
        constructor(
          name: string,
          args: import("../../src/components/parts-component").ComponentArgs<
            typeof parts
          >,
        ) {
          super(name, args);
          const queue = this.existingPart("queue")!;
          this.lookupPart(
            "deadLetters",
            queue.id.apply((id) => `${id}-dead-letters`),
          );
          this.lookupPart("alarm", "depth", "depth-alarm");
        }
      }

      const inbox = new Inbox("A", {
        existing: { queue: "https://sqs.example.com/123/mine" },
      });
      await pulumi.settle();

      expect(
        pulumi.resources
          .filter((r) => r.kind === "read")
          .map((r) => [r.name, r.options.id])
          .sort(),
      ).toEqual([
        ["AAlarmDepth", "depth-alarm"],
        ["ADeadLetters", "https://sqs.example.com/123/mine-dead-letters"],
        ["AQueue", "https://sqs.example.com/123/mine"],
      ]);
      expect(pulumi.resources.filter((r) => r.kind === "register").length).toBe(1);
      expect(inbox.nodes.deadLetters).toBeInstanceOf(aws.sqs.Queue);
      expect(Object.keys(inbox.nodes.alarm)).toEqual(["depth"]);
    });

    it("takes existing resources for a many part by id", async () => {
      const mine = new aws.cloudwatch.MetricAlarm("Mine", {
        comparisonOperator: "GreaterThanThreshold",
        evaluationPeriods: 1,
      });
      await pulumi.settle();
      pulumi.reset();

      const Inbox = defineInbox();
      const inbox = new Inbox("A", {
        alarms: ["depth", "age"],
        existing: { alarm: { depth: mine } },
      });
      await pulumi.settle();

      expect(inbox.nodes.alarm.depth).toBe(mine);
      expect(inbox.nodes.alarm.age).not.toBe(mine);
      const names = pulumi.resources.map((r) => r.name).sort();
      expect(names).toEqual(["A", "AAlarmAge", "AQueue"]);
    });

    it("rejects an existing resource for something the component doesn't have", () => {
      const Inbox = defineInbox();
      expect(
        () => new Inbox("A", { existing: { topic: "x" } as any }),
      ).toThrow(/"topic" is not something you can pass an existing resource for.*queue, deadLetters, alarm/);
    });

    it("rejects a transform for a part that is given", () => {
      const Inbox = defineInbox();
      expect(
        () =>
          new Inbox("A", {
            existing: { queue: "https://sqs.example.com/123/mine" },
            transform: { queue: { delaySeconds: 5 } },
          }),
      ).toThrow(/given an existing "queue".*nothing to transform/);
    });
  });

  // A part's key is what the user writes in `transform`, `existing` and
  // `nodes`. Its name is what a deployed app knows the resource by. `named()`
  // keeps the two apart.
  describe("named parts", () => {
    function defineNetwork() {
      const parts = {
        vpc: aws.ec2.Vpc,
        natSecurityGroup: named(
          optional(aws.ec2.SecurityGroup),
          "NatInstanceSecurityGroup",
        ),
        publicSubnet: named(many(aws.ec2.Subnet), "Subnet"),
        flowLog: named(aws.cloudwatch.LogGroup, "Logs"),
      };
      type Args = import("../../src/components/parts-component").ComponentArgs<
        typeof parts
      > & { nat?: boolean; zones?: string[] };
      return class Network extends component("acme:Network", parts) {
        constructor(name: string, args: Args = {}) {
          super(name, args);
          const vpc = this.part("vpc", { cidrBlock: "10.0.0.0/16" });
          if (args.nat) this.part("natSecurityGroup", { vpcId: vpc.id });
          for (const zone of args.zones ?? [])
            this.part("publicSubnet", zone, { vpcId: vpc.id });
          this.part("flowLog", {});
        }
      };
    }

    it("names the resource with the name, and everything else with the key", async () => {
      const Network = defineNetwork();
      const network = new Network("Net", {
        nat: true,
        zones: ["1", "2"],
        transform: {
          natSecurityGroup: { description: "custom" },
          publicSubnet: (args, _opts, name, zone) => {
            args.tags = { name, zone };
          },
        },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.name).sort()).toEqual([
        "Net",
        "NetLogs",
        "NetNatInstanceSecurityGroup",
        "NetSubnet1",
        "NetSubnet2",
        "NetVpc",
      ]);
      expect(Object.keys(network.nodes)).toEqual([
        "vpc",
        "natSecurityGroup",
        "publicSubnet",
        "flowLog",
      ]);
      expect(network.nodes.natSecurityGroup).toBeInstanceOf(aws.ec2.SecurityGroup);
      expect(network.nodes.flowLog).toBeInstanceOf(aws.cloudwatch.LogGroup);
      expect(Object.keys(network.nodes.publicSubnet)).toEqual(["1", "2"]);

      const resource = (name: string) =>
        pulumi.resources.find((r) => r.name === name)!;
      expect(resource("NetNatInstanceSecurityGroup").inputs.description).toBe(
        "custom",
      );
      expect(resource("NetSubnet2").inputs.tags).toEqual({
        name: "NetSubnet2",
        zone: "2",
      });
      // A security group is named with a tag made from the resource's name
      expect(resource("NetNatInstanceSecurityGroup").inputs.tags.Name).toMatch(
        /NetNatInstanceSecurityGroup$/,
      );
    });

    it("stays optional, and takes an existing resource by its key", async () => {
      const mine = new aws.ec2.SecurityGroup("Mine", {});
      await pulumi.settle();
      pulumi.reset();

      const Network = defineNetwork();
      const without = new Network("A");
      const given = new Network("B", {
        nat: true,
        existing: { natSecurityGroup: mine, flowLog: "/my/logs" },
      });
      await pulumi.settle();

      expect(without.nodes.natSecurityGroup).toBeUndefined();
      expect(given.nodes.natSecurityGroup).toBe(mine);
      // Looked up under the part's name
      expect(pulumi.resources.find((r) => r.kind === "read")).toMatchObject({
        name: "BLogs",
        options: { id: "/my/logs" },
      });
    });

    it("matches one created without part() by the name", async () => {
      const parts = {
        group: named(aws.ec2.SecurityGroup, "Firewall"),
        subnet: named(many(aws.ec2.Subnet), "PublicSubnet"),
      };
      class Loose extends component("acme:Loose", parts) {
        constructor(name: string) {
          super(name);
          new aws.ec2.SecurityGroup(`${name}Firewall`, {}, { parent: this });
          new aws.ec2.Subnet(
            `${name}PublicSubnet7`,
            { vpcId: "vpc-1" },
            { parent: this },
          );
        }
      }
      const loose = new Loose("Net");
      await pulumi.settle();

      expect(loose.nodes.group).toBeInstanceOf(aws.ec2.SecurityGroup);
      expect(Object.keys(loose.nodes.subnet)).toEqual(["7"]);
    });

    it("is typed like the part it wraps", () => {
      const parts = {
        group: named(optional(aws.ec2.SecurityGroup), "Firewall"),
        subnet: named(many(aws.ec2.Subnet), "PublicSubnet"),
        logs: named(aws.cloudwatch.LogGroup, "Logs"),
      };
      type Nodes = import("../../src/components/parts-component").Nodes<
        typeof parts
      >;
      const nodes = {} as Nodes;
      const group: aws.ec2.SecurityGroup | undefined = nodes.group;
      const subnets: Record<string, aws.ec2.Subnet> = nodes.subnet;
      const logs: aws.cloudwatch.LogGroup = nodes.logs;
      // @ts-expect-error An optional part may be missing
      const always: aws.ec2.SecurityGroup = nodes.group;
      expect([group, subnets, logs, always]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    });
  });

  describe("link()", () => {
    let Link: typeof import("../../src/components/link").Link;
    let Linkable: typeof import("../../src/components/linkable").Linkable;
    let env: typeof import("../../src/components/linkable").env;
    let permission: typeof import("../../src/components/aws/permission").permission;
    let iamStatements: typeof import("../../src/components/aws/permission").iamStatements;

    beforeAll(async () => {
      ({ Link } = await import("../../src/components/link"));
      ({ Linkable, env } = await import("../../src/components/linkable"));
      ({ permission, iamStatements } = await import(
        "../../src/components/aws/permission"
      ));
    });

    function defineStore() {
      const parts = { bucket: aws.s3.Bucket };
      return class Store extends component("acme:Store", parts) {
        constructor(name: string) {
          super(name);
          this.part("bucket", {});
        }
        link() {
          return {
            properties: { name: this.nodes.bucket.bucket },
            include: [
              permission({
                actions: ["s3:GetObject"],
                resources: [this.nodes.bucket.arn],
              }),
              env({ STORE_MODE: "read" }),
            ],
          };
        }
      };
    }

    it("makes a component linkable", async () => {
      const Store = defineStore();
      const store = new Store("Docs");
      await pulumi.settle();

      expect(Link.isLinkable(store)).toBe(true);
      const props = await pulumi.resolve(Link.getProperties([store]));
      expect(props.Docs.type).toBe("acme.Store");
      expect(props.Docs.name).toMatch(/^app-test-docsbucket-/);
    });

    it("leaves a component without link() unlinkable", async () => {
      const parts = { bucket: aws.s3.Bucket };
      class Plain extends component("acme:Plain", parts) {
        constructor(name: string) {
          super(name);
          this.part("bucket", {});
        }
      }
      const plain = new Plain("Docs");
      await pulumi.settle();
      expect(Link.isLinkable(plain)).toBe(false);
    });

    it("turns linked permissions into IAM statements", async () => {
      const Store = defineStore();
      const store = new Store("Docs");
      const statements = await pulumi.resolve(iamStatements([store]));
      await pulumi.settle();

      expect(statements).toEqual([
        {
          effect: "Allow",
          actions: ["s3:GetObject"],
          resources: ["arn:aws:mock:us-east-1:123456789012:DocsBucket"],
          conditions: undefined,
        },
      ]);
    });

    it("passes link properties to Linkable.env", async () => {
      const Store = defineStore();
      const store = new Store("Docs");
      const vars = await pulumi.resolve(Linkable.env([store]));
      await pulumi.settle();

      expect(JSON.parse(vars.SST_RESOURCE_Docs).type).toBe("acme.Store");
    });

    it("lets a function link it the way it links any component", async () => {
      const Store = defineStore();
      const store = new Store("Docs");
      await pulumi.settle();

      // Function, Worker and the sites read links through this method
      expect((store as any).getSSTLink().include).toMatchObject([
        { type: "aws.permission", actions: ["s3:GetObject"] },
        { type: "environment", env: { STORE_MODE: "read" } },
      ]);
    });

    it("lets Linkable.wrap override a component's link", async () => {
      const Store = defineStore();
      new Store("Before");
      Linkable.wrap(Store, () => ({ properties: { replaced: true } }));
      const store = new Store("Docs");
      const props = await pulumi.resolve(Link.getProperties([store]));
      await pulumi.settle();

      expect(props.Docs.replaced).toBe(true);
      expect(props.Docs.name).toBeUndefined();
    });
  });

  describe("mergeArgs", () => {
    it("merges nested objects and replaces everything else", () => {
      expect(
        mergeArgs(
          { a: { b: 1, c: 2 }, list: [1, 2], name: "x", keep: true },
          { a: { c: 3 }, list: [9], name: "y" },
        ),
      ).toEqual({ a: { b: 1, c: 3 }, list: [9], name: "y", keep: true });
    });

    it("merges into a default that is an output", async () => {
      const merged = mergeArgs(
        { tags: output({ a: "1", b: "2" }) } as any,
        { tags: { b: "3", c: output("4") } } as any,
      );
      expect(await pulumi.resolve(merged.tags)).toEqual({ a: "1", b: "3", c: "4" });
    });

    it("replaces an output default with an output", async () => {
      const merged = mergeArgs(
        { tags: output({ a: "1" }) } as any,
        { tags: output({ z: "9" }) } as any,
      );
      expect(await pulumi.resolve(merged.tags)).toEqual({ z: "9" });
    });

    // The object form of a transform is typed the way it's merged. These are
    // checked by the typecheck: an unused `@ts-expect-error` fails it.
    it("is typed to take a nested object in part, and anything else whole", () => {
      type Table = PartialArgs<aws.dynamodb.TableArgs>;
      const transforms: Table[] = [
        // A nested object is merged, so its required `enabled` can be left out
        { pointInTimeRecovery: { recoveryPeriodInDays: 7 } },
        { pointInTimeRecovery: output({ enabled: false }) },
        { tags: { team: output("storage") } },
        {
          globalSecondaryIndexes: [
            { name: "ByDate", hashKey: "date", projectionType: "ALL" },
          ],
        },
        // @ts-expect-error A nested key that doesn't exist
        { pointInTimeRecovery: { recoveryDays: 7 } },
        // @ts-expect-error A nested value of the wrong type
        { pointInTimeRecovery: { enabled: "yes" } },
        // @ts-expect-error An array is replaced, so its items are given whole
        { globalSecondaryIndexes: [{ name: "ByDate" }] },
      ];
      expect(transforms).toHaveLength(7);
    });
  });
});
