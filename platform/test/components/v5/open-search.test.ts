import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

const DOMAIN = "aws:opensearch/domain:Domain";

const pulumi = mockPulumi({
  state: (args) =>
    args.type === DOMAIN
      ? {
          endpoint: "search-domain.us-east-1.es.amazonaws.com",
          domainName: "my-domain",
          // A domain that's looked up has the tags it was created with
          tagsAll: args.id
            ? {
                "sst:ref:username": "searcher",
                "sst:ref:password": "secret-id",
              }
            : args.inputs.tags,
        }
      : {},
  // The password in the secret a domain is tagged with, or in another
  call: (args) =>
    args.token === "aws:secretsmanager/getSecretVersion:getSecretVersion"
      ? {
          secretString: JSON.stringify({
            username: "searcher",
            password:
              args.inputs.secretId === "secret-id"
                ? "stored-password"
                : `the password in ${args.inputs.secretId}`,
          }),
        }
      : undefined,
});

type OpenSearchClass =
  | typeof import("../../fixtures/v4/components/aws/open-search").OpenSearch
  | typeof import("../../../src/components/aws/open-search").OpenSearch;

describe("OpenSearch", () => {
  let Original: typeof import("../../fixtures/v4/components/aws/open-search").OpenSearch;
  let OpenSearch: typeof import("../../../src/components/aws/open-search").OpenSearch;

  beforeAll(async () => {
    Original = (await import("../../fixtures/v4/components/aws/open-search"))
      .OpenSearch;
    OpenSearch = (await import("../../../src/components/aws/open-search"))
      .OpenSearch;
    await import("../../../src/components/aws/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const dev = { url: "http://localhost:9200", password: "^Passw0rd^" };

  // Each case deploys the 4.x OpenSearch, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs: replacing the domain loses its data.
  describe("takes over a deployed OpenSearch", () => {
    pulumi.takeoverCases<OpenSearchClass, OpenSearchClass>({
      original: () => Original,
      v5: () => OpenSearch,
      cases: {
        "a domain": {
          create: (OpenSearch, opts) => {
            new OpenSearch("MySearch", {}, opts);
          },
          check: () => expect(resource("MySearchDomain").type).toBe(DOMAIN),
        },
        "a domain with everything set": {
          create: (OpenSearch, opts) => {
            new OpenSearch(
              "MySearch",
              {
                version: "OpenSearch_2.11",
                username: "searcher",
                password: "^Passw0rd^",
                instance: "m6g.large",
                storage: "100 GB",
                transform: {
                  domain: { ipAddressType: "dualstack" },
                  policy: (args) => {
                    args.accessPolicies = "{}";
                  },
                },
              },
              opts,
            );
          },
          check: () =>
            expect(resource("MySearchDomain").inputs).toMatchObject({
              engineVersion: "OpenSearch_2.11",
              clusterConfig: { instanceType: "m6g.large.search" },
              ebsOptions: { volumeSize: 100 },
              ipAddressType: "dualstack",
            }),
        },
        // SST 4 replaced the tags whole, the ones `get` reads included.
        // The V5 one keeps them next to yours, so the tags are updated.
        "tags set with an object transform": {
          create: (OpenSearch, opts) => {
            new OpenSearch(
              "MySearch",
              { transform: { domain: { tags: { team: "search" } } } },
              opts,
            );
          },
          changed: [["MySearchDomain", ["tags"]]],
          check: () =>
            expect(resource("MySearchDomain").inputs.tags).toEqual({
              team: "search",
              "sst:ref:username": "admin",
              "sst:ref:password": "MySearchSecret_id",
            }),
        },
        // With `dev` set, 4.x created a component for the pane `sst dev`
        // shows in every deploy, at the top of the app
        // The same for the domain's other nested settings
        "a nested setting set with an object transform": {
          create: (OpenSearch, opts) => {
            new OpenSearch(
              "MySearch",
              {
                transform: { domain: { clusterConfig: { instanceCount: 3 } } },
              },
              opts,
            );
          },
          changed: [["MySearchDomain", ["clusterConfig"]]],
        },
        // A function replaces one whole, as SST 4's object did
        "a master user given by its ARN, in a function": (OpenSearch, opts) => {
          new OpenSearch(
            "MySearch",
            {
              transform: {
                domain: (args) => {
                  args.advancedSecurityOptions = {
                    enabled: true,
                    internalUserDatabaseEnabled: false,
                    masterUserOptions: {
                      masterUserArn:
                        "arn:aws:iam::123456789012:role/search-admin",
                    },
                  };
                  return undefined;
                },
              },
            },
            opts,
          );
        },
        "a username, and a generated password": (OpenSearch, opts) => {
          new OpenSearch("MySearch", { username: "searcher" }, opts);
        },
        "a password of its own": {
          create: (OpenSearch, opts) => {
            new OpenSearch("MySearch", { password: "^Passw0rd^" }, opts);
          },
          check: () => expect(resource("MySearchPassword")).toBeUndefined(),
        },
        "dev args outside sst dev": {
          create: (OpenSearch, opts) => {
            new OpenSearch("MySearch", { dev }, opts);
          },
          unclaimed: ["sst:sst:DevCommand::MySearchDev"],
          check: () => {
            expect(resource("MySearchDomain").type).toBe(DOMAIN);
            expect(pulumi.reportOf("MySearch")?.dev).toBeUndefined();
          },
        },
        "dev args in sst dev": {
          create: (OpenSearch, opts) => {
            // @ts-ignore
            global.$dev = true;
            new OpenSearch("MySearch", { dev }, opts);
          },
          unclaimed: ["sst:sst:DevCommand::MySearchDev"],
          // The component itself reports the pane, in its outputs
          changed: [["MySearch", ["outputs"]]],
          check: () =>
            expect(pulumi.reportOf("MySearch")).toHaveProperty("dev"),
        },
        // 4.x looked the domain up at the top of the app. The V5 one looks
        // the same domain up inside itself. A lookup changes nothing in AWS.
        "a domain referenced with get": {
          create: (OpenSearch, opts) =>
            OpenSearch.get("MySearch", "app-dev-mysearch", opts),
          unclaimed: [`${DOMAIN}::MySearchDomain`],
          check: () => {
            expect(resource("MySearchDomain")).toMatchObject({
              kind: "read",
              options: { id: "app-dev-mysearch" },
            });
            // A lookup isn't given a name of its own: SST 4 looked it up
            // without a parent to keep one out
            expect(
              resource("MySearchDomain").inputs.domainName,
            ).toBeUndefined();
          },
        },
      },
    });
  });

  it("creates the domain as SST 4 did, and keeps the password in a secret", async () => {
    const search = new OpenSearch("MySearch");
    await pulumi.settle();

    expect(resource("MySearchDomain").inputs).toMatchObject({
      engineVersion: "OpenSearch_2.17",
      clusterConfig: { instanceType: "t3.small.search", instanceCount: 1 },
      ebsOptions: { ebsEnabled: true, volumeSize: 10, volumeType: "gp3" },
      advancedSecurityOptions: {
        enabled: true,
        masterUserOptions: { masterUserName: "admin" },
      },
      tags: {
        "sst:ref:username": "admin",
        "sst:ref:password": "MySearchSecret_id",
      },
    });
    expect(resource("MySearchPassword").inputs.length).toBe(32);
    expect(resource("MySearchDomainPolicy").inputs.domainName).toBe(
      "my-domain",
    );
    // It holds a secret, so the mock keeps it wrapped
    const stored = resource("MySearchSecretVersion").inputs.secretString;
    expect(JSON.parse(stored.value ?? stored).username).toBe("admin");
    expect(Object.keys(search.nodes).sort()).toEqual([
      "domain",
      "password",
      "policy",
      "secret",
      "secretVersion",
    ]);
    expect(await pulumi.resolve(search.url)).toBe(
      "https://search-domain.us-east-1.es.amazonaws.com",
    );
    expect(pulumi.reportOf("MySearch")?.hint).toBe(
      "https://search-domain.us-east-1.es.amazonaws.com",
    );
  });

  it("uses the password it's given, and generates none", async () => {
    new OpenSearch("MySearch", { password: "^Passw0rd^" });
    await pulumi.settle();
    expect(resource("MySearchPassword")).toBeUndefined();
    expect(
      resource("MySearchDomain").inputs.advancedSecurityOptions
        .masterUserOptions.masterUserPassword,
    ).toBe("^Passw0rd^");
  });

  it("links its URL and its master user", async () => {
    const search = new OpenSearch("MySearch", {
      username: "searcher",
      password: "^Passw0rd^",
    });
    await pulumi.settle();
    expect(await pulumi.resolve(search.link().properties)).toEqual({
      username: "searcher",
      password: "^Passw0rd^",
      url: "https://search-domain.us-east-1.es.amazonaws.com",
    });
  });

  it("refuses less than 10 GB of storage", async () => {
    const errors = await applyErrors(
      () => new OpenSearch("MySearch", { storage: "5 GB" }),
      pulumi.settle,
    );
    expect(errors).toContain(
      `The "storage" of the "MySearch" OpenSearch domain is 5 GB. It has to be at least 10 GB.`,
    );
  });

  it("reads the username and the password of a domain it's given", async () => {
    const search = OpenSearch.get("MySearch", "app-dev-mysearch");
    await pulumi.settle();
    expect(resource("MySearchSecret")).toBeUndefined();
    expect(resource("MySearchDomainPolicy")).toBeUndefined();
    expect(await pulumi.resolve(search.link().properties)).toEqual({
      username: "searcher",
      password: "stored-password",
      url: "https://search-domain.us-east-1.es.amazonaws.com",
    });
    expect(pulumi.reportOf("MySearch")).toBeUndefined();
  });

  it("reads the password from the secret it's given, or uses its own", async () => {
    const fromSecret = new OpenSearch("FromSecret", {
      existing: { domain: "app-dev-mysearch", secret: "my-secret" },
    });
    const given = new OpenSearch("Given", {
      username: "owner",
      password: "known",
      existing: { domain: "app-dev-mysearch" },
    });
    await pulumi.settle();

    expect(resource("FromSecretSecret")).toMatchObject({
      kind: "read",
      options: { id: "my-secret" },
    });
    expect(
      await pulumi.resolve([fromSecret.username, fromSecret.password]),
    ).toEqual(["searcher", "the password in my-secret"]);
    expect(await pulumi.resolve([given.username, given.password])).toEqual([
      "owner",
      "known",
    ]);
  });

  it("turns down what it would create next to a domain it's given", () => {
    for (const part of ["policy", "secretVersion", "password"])
      expect(
        () =>
          new OpenSearch("MySearch", {
            existing: { domain: "app-dev-mysearch", [part]: "x" },
          }),
      ).toThrow(
        `"existing.${part}" isn't an option for the "MySearch" OpenSearch domain. It's given an existing "domain", which it uses the way it is, so it creates nothing this would stand in for. Remove it.`,
      );
  });

  it("looks a domain up by the name in the ARN it's given", async () => {
    const search = OpenSearch.get(
      "MySearch",
      "arn:aws:es:us-east-1:123456789012:domain/app-dev-mysearch",
    );
    await pulumi.settle();
    expect(resource("MySearchDomain").options.id).toBe("app-dev-mysearch");
    expect((await pulumi.resolve(search.link().properties)).username).toBe(
      "searcher",
    );
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    it("connects to the local server, and says how to set it up", async () => {
      const search = new OpenSearch("MySearch", {
        dev: { username: "searcher", password: "" },
        password: "unused",
      });
      await pulumi.settle();
      expect(pulumi.resources.filter((r) => r.custom)).toEqual([]);
      expect(await pulumi.resolve(search.link().properties)).toEqual({
        username: "searcher",
        password: "",
        url: "http://localhost:9200",
      });
      expect(await pulumi.resolve(search.id)).toBe("placeholder");
      const pane = pulumi.reportOf("MySearch")?.dev;
      expect(pane.command).toBe("sst print-and-not-quit");
      expect(pane.environment.SST_DEV_COMMAND_MESSAGE).toMatch(
        /username: "searcher"\n  password: ".*\[no password\].*"\n\nListening on "http:\/\/localhost:9200"/,
      );
      expect(() => search.nodes.domain).toThrow(
        /Cannot access `nodes.domain` of "MySearch" in `sst dev`/,
      );
    });

    it("connects with the top-level username and password when dev has none", async () => {
      const search = new OpenSearch("MySearch", {
        username: "searcher",
        password: "^Passw0rd^",
        dev: {},
      });
      await pulumi.settle();
      expect(await pulumi.resolve(search.link().properties)).toEqual({
        username: "searcher",
        password: "^Passw0rd^",
        url: "http://localhost:9200",
      });
      expect(
        pulumi.reportOf("MySearch")?.dev.environment.SST_DEV_COMMAND_MESSAGE,
      ).toContain('password: "^Passw0rd^"');
    });

    // An output that resolves to nothing is as good as leaving it out
    it("falls back for dev values that are outputs of nothing", async () => {
      const { output } = await import("@pulumi/pulumi");
      const search = new OpenSearch("MySearch", {
        username: "searcher",
        password: "^Passw0rd^",
        dev: {
          url: output(undefined as unknown as string),
          username: output(""),
          password: output(undefined as unknown as string),
        },
      });
      await pulumi.settle();
      expect(await pulumi.resolve(search.link().properties)).toEqual({
        username: "searcher",
        password: "^Passw0rd^",
        url: "http://localhost:9200",
      });
    });

    it("needs the local server's password", () => {
      expect(
        () =>
          new OpenSearch("MySearch", { dev: { url: "http://localhost:9200" } }),
      ).toThrow(
        `The "MySearch" OpenSearch domain needs the password of your local server to connect to it in sst dev. Set "dev.password", or "password".`,
      );
    });

    it("deploys the domain without dev", async () => {
      new OpenSearch("MySearch");
      await pulumi.settle();
      expect(resource("MySearchDomain").type).toBe(DOMAIN);
      expect(pulumi.reportOf("MySearch")?.dev).toBeUndefined();
    });
  });
});
