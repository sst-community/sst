import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, type TakeoverWay } from "../../../helpers/graph";

const KEY = "tls:index/privateKey:PrivateKey";
// The mock builds a worker into a file of this extension
const handler = "src/auth.mjs";
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----";
const PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----";

// The key pair the provider makes on this machine
const pulumi = mockPulumi({
  state: (args) =>
    args.type === KEY
      ? { privateKeyPemPkcs8: PRIVATE_KEY, publicKeyPem: PUBLIC_KEY }
      : {},
});

type AuthClass =
  | typeof import("../../../../src/components/cloudflare/auth").Auth
  | typeof import("../../../../src/components/cloudflare/v5/auth").Auth;

describe("Auth", () => {
  let Original: typeof import("../../../../src/components/cloudflare/auth").Auth;
  let Auth: typeof import("../../../../src/components/cloudflare/v5/auth").Auth;
  let Worker: typeof import("../../../../src/components/cloudflare/v5/worker").Worker;
  let Secret: typeof import("../../../../src/components/secret").Secret;

  beforeAll(async () => {
    Original = (await import("../../../../src/components/cloudflare/auth"))
      .Auth;
    Auth = (await import("../../../../src/components/cloudflare/v5/auth")).Auth;
    Worker = (await import("../../../../src/components/cloudflare/v5/worker"))
      .Worker;
    Secret = (await import("../../../../src/components/secret")).Secret;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  // The bindings are kept secret, recorded under `value`
  const bindingsOf = (name: string) => {
    const bindings = resource(name).inputs.bindings;
    expect(bindings).toHaveProperty("value");
    return bindings.value as Record<string, any>[];
  };

  // The private key is a secret binding now, where SST 4 made it a plain
  // text one. SST 4 created the Worker with no parent, so with the app's
  // provider, whatever the auth had: with a provider of its own, the V5
  // one gives the Worker that one.
  const changed = (way: TakeoverWay): [string, string[]][] => [
    [
      "MyAuthAuthenticatorScript",
      way === "with another provider"
        ? ["bindings", "options.provider"]
        : ["bindings"],
    ],
  ];

  // Each case deploys the 4.x Auth, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one. 4.x created
  // the key pair and the Worker at the top of the app; V5 creates them
  // inside, with the names they had.
  describe("takes over a deployed Auth", () => {
    pulumi.takeoverCases<AuthClass, AuthClass>({
      original: () => Original,
      v5: () => Auth,
      provider: "cloudflare",
      changed,
      check: () => {
        expect(resource("MyAuthKeypair").type).toBe(KEY);
        expect(resource("MyAuthKeypair").inputs).toEqual({ algorithm: "RSA" });
        expect(resource("MyAuthKeypair").parent).toMatch(
          /sst:cloudflare:Auth::MyAuth$/,
        );
      },
      cases: {
        "an auth server": (Auth, opts) => {
          new Auth("MyAuth", { authenticator: { handler } }, opts);
        },
        "an auth server whose worker has links and environment variables": (
          Auth,
          opts,
        ) => {
          const secret = new Secret("MySecret", "shh");
          new Auth(
            "MyAuth",
            {
              authenticator: {
                handler,
                link: [secret],
                environment: { MODE: "auth" },
              },
            },
            opts,
          );
        },
      },
    });
  });

  it("gives its Worker the private key as a secret, and the public key", async () => {
    new Auth("MyAuth", {
      authenticator: { handler, environment: { MODE: "auth" } },
    });
    await pulumi.settle();
    const bindings = bindingsOf("MyAuthAuthenticatorScript");
    expect(bindings).toContainEqual({
      type: "secret_text",
      name: "AUTH_PRIVATE_KEY",
      text: PRIVATE_KEY,
    });
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "AUTH_PUBLIC_KEY",
      text: PUBLIC_KEY,
    });
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "MODE",
      text: "auth",
    });
    expect(bindings.filter((b) => b.name === "AUTH_PRIVATE_KEY")).toHaveLength(
      1,
    );
  });

  // A transformation puts it there after the user's transform
  it("keeps the private key secret when the Worker is transformed", async () => {
    new Auth("MyAuth", {
      authenticator: handler,
      transform: {
        authenticator: {
          environment: { AUTH_PRIVATE_KEY: "plain" },
          transform: {
            worker: (args) => {
              args.logpush = true;
            },
          },
        },
      },
    });
    await pulumi.settle();
    expect(resource("MyAuthAuthenticatorScript").inputs.logpush).toBe(true);
    expect(
      bindingsOf("MyAuthAuthenticatorScript").filter(
        (b) => b.name === "AUTH_PRIVATE_KEY",
      ),
    ).toEqual([
      { type: "secret_text", name: "AUTH_PRIVATE_KEY", text: PRIVATE_KEY },
    ]);
  });

  it("gives its Worker a URL, and links its URL and public key", async () => {
    const auth = new Auth("MyAuth", { authenticator: { handler, url: false } });
    new Worker("Api", { handler, link: [auth] });
    await pulumi.settle();
    expect(
      resource("MyAuthAuthenticatorUrl.sst.cloudflare.WorkerUrl").inputs
        .enabled,
    ).toBe(true);
    expect(
      bindingsOf("ApiScript").find((b) => b.name === "SST_RESOURCE_MyAuth"),
    ).toMatchObject({ type: "secret_text" });
    expect(auth.nodes.authenticator).toBe(auth.authenticator);
    expect(auth.nodes.key).toBe(auth.key);
  });

  it("refuses an authenticator that's an output, or missing", () => {
    expect(
      () => new Auth("MyAuth", { authenticator: output(handler) as any }),
    ).toThrow(
      'The "authenticator" of the "MyAuth" auth server has to be a plain value, not an output.',
    );
    expect(() => new Auth("Other", {} as any)).toThrow(
      'The "Other" auth server needs an "authenticator"',
    );
  });

  it("refuses an existing authenticator, and SST 4's transform", () => {
    expect(
      () =>
        new Auth("MyAuth", {
          authenticator: handler,
          existing: { authenticator: "id" },
        }),
    ).toThrow(
      `"existing.authenticator" isn't an option for the "MyAuth" auth server.`,
    );
    expect(
      () =>
        new Auth("Other", {
          authenticator: handler,
          transform: { bucketPolicy: {} } as any,
        }),
    ).toThrow(`"bucketPolicy" is not something you can transform`);
  });
});
