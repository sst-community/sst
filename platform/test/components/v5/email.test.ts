import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const pulumi = mockPulumi({
  state: (args) => {
    switch (args.type) {
      // What SES gives a domain identity to put in DNS
      case "aws:sesv2/emailIdentity:EmailIdentity":
        return {
          arn: `arn:aws:ses:us-east-1:123456789012:identity/${args.inputs.emailIdentity}`,
          // None when it signs with a key of your own
          dkimSigningAttributes: args.inputs.dkimSigningAttributes
            ?.domainSigningPrivateKey
            ? { tokens: [] }
            : // Not in order, as SES may give them
              { tokens: ["tokenc", "tokena", "tokenb"] },
        };
      default:
        return {};
    }
  },
});

// A domain that signs with a DKIM key of its own
const byodkim = {
  identity: {
    dkimSigningAttributes: {
      domainSigningPrivateKey: "key",
      domainSigningSelector: "sel",
    },
  },
};

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:bounces";
const BUS_ARN = "arn:aws:events:us-east-1:123456789012:event-bus/mail";

describe("Email", () => {
  let OriginalEmail: typeof import("../../fixtures/v4/components/aws/email").Email;
  let Email: typeof import("../../../src/components/aws/email").Email;
  let cloudflare: typeof import("../../../src/components/cloudflare/dns");
  let vercel: typeof import("../../../src/components/vercel/dns");

  beforeAll(async () => {
    OriginalEmail = (await import("../../fixtures/v4/components/aws/email"))
      .Email;
    Email = (await import("../../../src/components/aws/email")).Email;
    await import("../../../src/components/aws/takeover/email");
    cloudflare = await import("../../../src/components/cloudflare/dns");
    vercel = await import("../../../src/components/vercel/dns");
  });

  beforeEach(() => pulumi.reset());

  const names = () => pulumi.resources.map((r) => r.name).sort();
  const find = (name: string) => pulumi.resources.find((r) => r.name === name)!;

  // Each case deploys the 4.x Email, then the same thing as the V5 one.
  // Everything the 4.x Email created has to be kept, with the same inputs.
  describe("takes over a deployed Email", () => {
    pulumi.takeoverCases({
      original: () => OriginalEmail,
      v5: () => Email,
      cases: {
        "an email address": (Email, opts) =>
          new Email("MyEmail", { sender: "spongebob@example.com" }, opts),
        "a domain, with its DNS records": {
          create: (Email, opts) =>
            new Email("MyEmail", { sender: "example.com" }, opts),
          check: () => {
            // Three DKIM records and a DMARC record, each with its zone lookup
            const records = pulumi.resources
              .filter((r) => r.type === "aws:route53/record:Record")
              .map((r) => `${r.inputs.type} ${r.inputs.name}`)
              .sort();
            expect(records).toEqual([
              "CNAME tokena._domainkey.example.com",
              "CNAME tokenb._domainkey.example.com",
              "CNAME tokenc._domainkey.example.com",
              "TXT _dmarc.example.com",
            ]);
            expect(names()).toContain("MyEmailVerification");
          },
        },
        "a domain with DMARC and a custom MAIL FROM domain": {
          create: (Email, opts) =>
            new Email(
              "MyEmail",
              {
                sender: "example.com",
                dmarc: "v=DMARC1; p=quarantine; adkim=s; aspf=s;",
                mailFrom: {
                  domain: "mail.example.com",
                  rejectOnMxFailure: true,
                },
              },
              opts,
            ),
          check: () => {
            expect(find("MyEmailMailFrom").inputs).toMatchObject({
              mailFromDomain: "mail.example.com",
              behaviorOnMxFailure: "REJECT_MESSAGE",
            });
            expect(
              pulumi.resources
                .filter((r) => r.type === "aws:route53/record:Record")
                .map((r) => `${r.inputs.type} ${r.inputs.name}`),
            ).toEqual(
              expect.arrayContaining([
                "MX mail.example.com",
                "TXT mail.example.com",
              ]),
            );
          },
        },
        "a domain on Cloudflare": (Email, opts) =>
          new Email(
            "MyEmail",
            {
              sender: "example.com",
              dns: cloudflare.dns(),
              mailFrom: { domain: "mail.example.com" },
            },
            opts,
          ),
        "a domain that signs with a key of its own": {
          original: (opts) =>
            new OriginalEmail(
              "MyEmail",
              { sender: "example.com", transform: byodkim },
              opts,
            ),
          v5: (opts) =>
            new Email(
              "MyEmail",
              { sender: "example.com", dkim: false, transform: byodkim },
              opts,
            ),
        },
        "a domain on Vercel": (Email, opts) =>
          new Email(
            "MyEmail",
            {
              sender: "example.com",
              dns: vercel.dns({ domain: "example.com" }),
            },
            opts,
          ),
        "a domain whose DNS records are added by hand": (Email, opts) =>
          new Email("MyEmail", { sender: "example.com", dns: false }, opts),
        "events, one with a name that isn't capitalized": {
          create: (Email, opts) =>
            new Email(
              "MyEmail",
              {
                sender: "spongebob@example.com",
                events: [
                  {
                    name: "OnBounce",
                    types: ["bounce", "complaint"],
                    topic: TOPIC_ARN,
                  },
                  {
                    name: "deliveries",
                    types: ["delivery", "delivery-delay"],
                    bus: BUS_ARN,
                  },
                ],
              },
              opts,
            ),
          // The 4.x name is kept for the event whose name V5 would change
          check: () => {
            expect(names()).toEqual(
              expect.arrayContaining([
                "MyEmailEventOnBounce",
                "MyEmailEventDeliveries",
              ]),
            );
            expect(
              find("MyEmailEventDeliveries").inputs.eventDestination
                .matchingEventTypes,
            ).toEqual(["DELIVERY", "DELIVERY_DELAY"]);
          },
        },
        "a transform": (Email, opts) =>
          new Email(
            "MyEmail",
            {
              sender: "spongebob@example.com",
              transform: {
                identity: { tags: { team: "mail" } },
                configurationSet: { sendingOptions: { sendingEnabled: true } },
              },
            },
            opts,
          ),
        "an identity referenced with get": (Email, opts) =>
          Email.get("MyEmail", "spongebob@example.com", opts),
      },
    });
  });

  it("creates what a domain needs, and nothing more for an address", async () => {
    const domain = new Email("Domain", { sender: "example.com" });
    const address = new Email("Address", { sender: "spongebob@example.com" });
    await pulumi.settle();

    expect(domain.nodes.verification).toBeDefined();
    expect(domain.nodes.mailFromAttributes).toBeUndefined();
    expect(address.nodes.verification).toBeUndefined();
    expect(names().filter((n) => n.startsWith("Address"))).toEqual([
      "Address",
      "AddressConfig",
      "AddressIdentity",
    ]);
    // The DNS records aren't parts: they're the DNS adapter's
    expect(Object.keys(domain.nodes)).not.toContain("record");
  });

  it("names a domain's DKIM records after their place, so a preview knows them", async () => {
    new Email("MyEmail", { sender: "example.com" });
    await pulumi.settle();

    const dkim = pulumi.resources
      .filter((r) => r.inputs.type === "CNAME")
      .map((r) => [r.name, r.inputs.name])
      .sort();
    expect(dkim).toEqual([
      [
        "MyEmailCNAMERecordDkim1domainkeyexamplecom",
        "tokena._domainkey.example.com",
      ],
      [
        "MyEmailCNAMERecordDkim2domainkeyexamplecom",
        "tokenb._domainkey.example.com",
      ],
      [
        "MyEmailCNAMERecordDkim3domainkeyexamplecom",
        "tokenc._domainkey.example.com",
      ],
    ]);
  });

  it("signs with a key of your own, and still creates the domain's other records", async () => {
    const { applyErrors } = await import("../../helpers/apply-errors");
    const own = await applyErrors(
      () =>
        new Email("Own", {
          sender: "example.com",
          dkim: false,
          mailFrom: { domain: "mail.example.com" },
          transform: byodkim,
        }),
      pulumi.settle,
    );
    expect(own).toEqual([]);
    expect(
      pulumi.resources
        .filter((r) => r.type === "aws:route53/record:Record")
        .map((r) => `${r.inputs.type} ${r.inputs.name}`)
        .sort(),
    ).toEqual([
      "MX mail.example.com",
      "TXT _dmarc.example.com",
      "TXT mail.example.com",
    ]);

    pulumi.reset();
    const told = await applyErrors(
      () => new Email("Told", { sender: "example.com", transform: byodkim }),
      pulumi.settle,
    );
    expect(told).toContainEqual(
      expect.stringContaining(
        `SES gave the "Told" email 0 DKIM tokens. It gives 3 when it signs with a key of its own. To sign with your own key, set "dkim" to false`,
      ),
    );
    expect(
      () =>
        new Email("Address", { sender: "spongebob@example.com", dkim: false }),
    ).toThrow(
      `"dkim" is only an option for the "Address" email when its "sender" is a domain, and it's the address "spongebob@example.com".`,
    );
  });

  it("names the configuration set as 4.x did", async () => {
    const email = new Email("MyEmail", { sender: "spongebob@example.com" });
    await pulumi.settle();
    expect(find("MyEmailConfig").type).toBe(
      "aws:sesv2/configurationSet:ConfigurationSet",
    );
    expect(email.nodes.configurationSet).toBeDefined();
    expect(find("MyEmailIdentity").inputs.configurationSetName).toBe(
      find("MyEmailConfig").inputs.configurationSetName,
    );
  });

  it("looks up the configuration set of an identity referenced with get", async () => {
    const email = Email.get("MyEmail", "spongebob@example.com");
    await pulumi.settle();

    expect(
      pulumi.resources
        .filter((r) => r.kind === "read")
        .map((r) => r.name)
        .sort(),
    ).toEqual(["MyEmailConfig", "MyEmailIdentity"]);
    expect(email.nodes.identity).toBeDefined();
  });

  it("uses the configuration set it's given next to an identity", async () => {
    const email = new Email("MyEmail", {
      existing: {
        identity: "spongebob@example.com",
        configurationSet: "my-config",
      },
    } as any);
    await pulumi.settle();

    expect(
      pulumi.resources
        .filter((r) => r.kind === "read")
        .map((r) => [r.name, r.options.id])
        .sort(),
    ).toEqual([
      ["MyEmailConfig", "my-config"],
      ["MyEmailIdentity", "spongebob@example.com"],
    ]);
    expect(email.nodes.configurationSet).toBeDefined();
  });

  it("turns down what it would create next to an identity it's given", () => {
    for (const part of ["mailFromAttributes", "verification"])
      expect(
        () =>
          new Email("MyEmail", {
            existing: { identity: "spongebob@example.com", [part]: "x" },
          } as any),
      ).toThrow(
        `"existing.${part}" isn't an option for the "MyEmail" email. It's given an existing "identity", which it uses the way it is, so it creates nothing this would stand in for. Remove it.`,
      );
  });

  it("links the sender and configuration set, with permission to send", async () => {
    const email = new Email("MyEmail", { sender: "spongebob@example.com" });
    await pulumi.settle();

    const link = email.link();
    expect(await pulumi.resolve(link.properties)).toEqual({
      sender: "spongebob@example.com",
      configSet: find("MyEmailConfig").inputs.configurationSetName,
    });
    const actions = await pulumi.resolve(
      link.include.map((p: any) => p.actions),
    );
    expect(actions).toEqual([
      ["ses:*"],
      ["ses:SendEmail", "ses:SendRawEmail", "ses:SendTemplatedEmail"],
    ]);
  });

  it("says what's wrong with args that don't fit the sender", () => {
    const address = "spongebob@example.com";
    expect(
      () => new Email("A", { sender: address, dns: false as any }),
    ).not.toThrow();
    expect(
      () =>
        new Email("B", { sender: address, dns: { provider: "aws" } as any }),
    ).toThrow(
      `"dns" is only an option for the "B" email when its "sender" is a domain, and it's the address "spongebob@example.com".`,
    );
    expect(
      () => new Email("C", { sender: address, dmarc: "v=DMARC1; p=none;" }),
    ).toThrow(`"dmarc" is only an option for the "C" email when its "sender"`);
    expect(
      () =>
        new Email("D", {
          sender: address,
          mailFrom: { domain: "mail.example.com" },
        }),
    ).toThrow(
      `"mailFrom" is only an option for the "D" email when its "sender"`,
    );
    expect(
      () =>
        new Email("E", {
          sender: "example.com",
          mailFrom: { domain: "mail.other.com" },
        }),
    ).toThrow(
      `The "mailFrom.domain" of the "E" email is "mail.other.com". It has to be a subdomain of its "sender", "example.com".`,
    );
  });

  it("needs plain values for what decides what's created", () => {
    expect(
      () => new Email("A", { sender: output("example.com") as any }),
    ).toThrow(`The "sender" of the "A" email has to be a plain value`);
    expect(
      () =>
        new Email("B", {
          sender: "spongebob@example.com",
          events: [{ name: output("OnBounce") as any, types: ["bounce"] }],
        }),
    ).toThrow(`The name of each of the "events" of the "B" email`);
  });
});
