import {
  ComponentResourceOptions,
  Output,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { getRegionOutput, ses, sesv2 } from "@pulumi/aws";
import {
  V5Args,
  component,
  many,
  named,
  optional,
} from "../../parts-component";
import { plain, plainDeep } from "../../args";
import type { Plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { dns as awsDns } from "../dns";
import { permission } from "../permission";
import type { EmailArgs as OriginalEmailArgs } from "../email";

const parts = () => ({
  /**
   * The Amazon SES identity: the email address or the domain the emails are
   * sent from.
   */
  identity: sesv2.EmailIdentity,
  /**
   * The Amazon SES configuration set the identity sends with.
   */
  configurationSet: named(sesv2.ConfigurationSet, "Config"),
  /**
   * The custom MAIL FROM domain, when `mailFrom` is set.
   */
  mailFromAttributes: named(
    optional(sesv2.EmailIdentityMailFromAttributes),
    "MailFrom",
  ),
  /**
   * Where each of the `events` is sent, by the event's name.
   */
  event: many(sesv2.ConfigurationSetEventDestination),
  /**
   * Waits for Amazon SES to verify the domain, when `sender` is a domain.
   */
  verification: optional(ses.DomainIdentityVerification),
});

export interface EmailArgs
  extends V5Args<
    Omit<OriginalEmailArgs, "sender" | "dns" | "mailFrom" | "events">,
    typeof parts
  > {
  /**
   * The email address or domain name that you want to send emails from.
   *
   * It has to be a plain value: whether it's a domain decides what's created
   * to verify it.
   *
   * :::note
   * You'll need to verify the email address or domain you are using.
   * :::
   *
   * @example
   *
   * Using an email address as the sender. You'll need to verify the email address.
   * When you deploy your app, you will receive an email from AWS SES with a link to verify the
   * email address.
   *
   * ```ts
   * {
   *   sender: "john.smith@gmail.com"
   * }
   * ```
   *
   * Using a domain name as the sender. You'll need to verify that you own the domain.
   * Once you verified, you can send emails from any email addresses in the domain.
   *
   * :::tip
   * SST can automatically verify the domain for the `dns` adapter that's specified.
   * :::
   *
   * To verify the domain, you need to add the verification records to your domain's DNS.
   * This can be done automatically for the supported `dns` adapters.
   *
   * ```ts
   * {
   *   sender: "example.com"
   * }
   * ```
   *
   * If the domain is hosted on Cloudflare.
   *
   * ```ts
   * {
   *   sender: "example.com",
   *   dns: sst.cloudflare.dns()
   * }
   * ```
   */
  sender: Plain<OriginalEmailArgs["sender"]>;
  /**
   * The DNS adapter you want to use for managing DNS records. Only specify this if you
   * are using a domain name as the `sender`.
   *
   * It has to be a plain value.
   *
   * :::note
   * If `dns` is set to `false`, you have to add the DNS records manually to verify
   * the domain.
   * :::
   *
   * @default `sst.aws.dns`
   *
   * @example
   *
   * Specify the hosted zone ID for the domain.
   *
   * ```js
   * {
   *   dns: sst.aws.dns({
   *     zone: "Z2FDTNDATAQYW2"
   *   })
   * }
   * ```
   *
   * Domain is hosted on Cloudflare.
   *
   * ```js
   * {
   *   dns: sst.cloudflare.dns()
   * }
   * ```
   */
  dns?: Plain<OriginalEmailArgs["dns"]>;
  /**
   * Configure a custom [MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
   * for the emails you send. This sets the `Return-Path` (envelope sender) to use a subdomain of
   * your own domain instead of the default `amazonses.com`. It improves SPF alignment for DMARC
   * and routes bounce and complaint feedback through your domain.
   *
   * This'll create the required MX and SPF DNS records for the MAIL FROM subdomain.
   *
   * It has to be a plain value, and so do its fields.
   *
   * :::note
   * This is only valid when `sender` is a domain. The MAIL FROM `domain` must be a subdomain
   * of the `sender` domain.
   * :::
   *
   * @default No custom MAIL FROM domain
   *
   * @example
   * ```js
   * {
   *   mailFrom: {
   *     domain: "mail.example.com"
   *   }
   * }
   * ```
   */
  mailFrom?: Plain<OriginalEmailArgs["mailFrom"]>;
  /**
   * Configure event notifications for this Email component.
   *
   * The list has to be a plain value, and so does each event's `name`: an event's
   * destination is named after it, in `nodes.event`. Its other fields can be outputs.
   *
   * @default No event notifications
   * @example
   *
   * ```js
   * {
   *   events: [
   *     {
   *       name: "OnBounce",
   *       types: ["bounce"],
   *       topic: "arn:aws:sns:us-east-1:123456789012:MyTopic"
   *     }
   *   ]
   * }
   * ```
   */
  events?: Plain<OriginalEmailArgs["events"]>;
}

/**
 * The `Email` component lets you send emails in your app.
 * It uses [Amazon Simple Email Service](https://aws.amazon.com/ses/).
 *
 * It takes the same args as [`sst.aws.Email`](/docs/component/aws/email). It's built
 * from parts, so every resource it creates can be transformed, is available in `nodes`,
 * and can be swapped for one you already have.
 *
 * You can configure it to send emails from a specific email address or from any email addresses
 * in a domain.
 *
 * :::tip
 * New AWS SES accounts are in _sandbox mode_ and need to [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
 * :::
 *
 * By default, new AWS SES accounts are in the _sandbox mode_ and can only send
 * email to verified email addresses and domains. It also limits your account to a sending
 * quota. To remove these restrictions, you need to [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
 *
 * #### Sending from an email address
 *
 * For using an email address as the sender, you need to verify the email address.
 *
 * ```ts title="sst.config.ts"
 * const email = new sst.aws.v5.Email("MyEmail", {
 *   sender: "spongebob@example.com",
 * });
 * ```
 *
 * #### Sending from a domain
 *
 * When you use a domain as the sender, you'll need to verify that you own the domain.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Email("MyEmail", {
 *   sender: "example.com"
 * });
 * ```
 *
 * #### Configuring DMARC
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Email("MyEmail", {
 *   sender: "example.com",
 *   dmarc: "v=DMARC1; p=quarantine; adkim=s; aspf=s;"
 * });
 * ```
 *
 * #### Configuring a custom MAIL FROM domain
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Email("MyEmail", {
 *   sender: "example.com",
 *   mailFrom: {
 *     domain: "mail.example.com"
 *   }
 * });
 * ```
 *
 * #### Link to a resource
 *
 * You can link it to a function or your Next.js app to send emails.
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.aws.v5.Function("MyApi", {
 *   handler: "sender.handler",
 *   link: [email]
 * });
 * ```
 *
 * Now in your function you can use the AWS SES SDK to send emails.
 *
 * ```ts title="sender.ts" {1, 8}
 * import { Resource } from "sst";
 * import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
 *
 * const client = new SESv2Client();
 *
 * await client.send(
 *   new SendEmailCommand({
 *     FromEmailAddress: Resource.MyEmail.sender,
 *     Destination: {
 *       ToAddresses: ["patrick@example.com"]
 *     },
 *     Content: {
 *       Simple: {
 *         Subject: { Data: "Hello World!" },
 *         Body: { Text: { Data: "Sent from my SST app." } }
 *       }
 *     }
 *   })
 * );
 * ```
 *
 * #### Switch from `sst.aws.Email`
 *
 * Change `sst.aws.Email` to `sst.aws.v5.Email` and keep the name. The identity,
 * the configuration set and the DNS records are kept.
 *
 * What's written differently:
 *
 * - `sender`, `dns`, `mailFrom` and `events` have to be plain values, not outputs.
 *   The name of each of the `events` is how its destination is known.
 * - `dmarc` can only be set when `sender` is a domain, and that's checked even when
 *   it's given as an output.
 * - `transform` also takes `event` and `verification`.
 *
 * What changes when you deploy:
 *
 * - Nothing in AWS. An event whose name isn't a capitalized name made of letters and
 *   numbers is kept under the name 4.x gave it.
 */
export class Email extends component("sst:aws:Email", parts) {
  private readonly senderValue: Output<string>;

  constructor(name: string, args: EmailArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    // An identity that's already there: find the configuration set it sends with
    const existing = this.existingPart("identity");
    if (existing) {
      this.lookupPart(
        "configurationSet",
        existing.configurationSetName.apply((set) => set!),
      );
      this.senderValue = existing.emailIdentity;
      return;
    }

    const what = (arg: string) => `The "${arg}" of the "${name}" email`;
    const sender = plain(args.sender, what("sender")) as string;
    const dns = plain(args.dns, what("dns"));
    const mailFrom = plainDeep(args.mailFrom, what("mailFrom")) as
      | { domain: string; rejectOnMxFailure?: boolean }
      | undefined;
    const events = plain(args.events, what("events")) ?? [];
    for (const event of events)
      plain(
        event.name,
        `The name of each of the "events" of the "${name}" email`,
      );

    const isDomain = !sender.includes("@");
    if (!isDomain && dns)
      throw new VisibleError(
        `The "dns" property is only valid when "sender" is a domain.`,
      );
    if (!isDomain && args.dmarc !== undefined)
      throw new VisibleError(
        `The "dmarc" property is only valid when "sender" is a domain.`,
      );
    if (mailFrom && !isDomain)
      throw new VisibleError(
        `The "mailFrom" property is only valid when "sender" is a domain.`,
      );
    if (mailFrom && !mailFrom.domain.endsWith(`.${sender}`))
      throw new VisibleError(
        `The "mailFrom.domain" "${mailFrom.domain}" must be a subdomain of the "sender" domain "${sender}".`,
      );

    const configurationSet = this.part("configurationSet", {
      configurationSetName: "",
    });
    const identity = this.part("identity", {
      emailIdentity: sender,
      configurationSetName: configurationSet.configurationSetName,
    });
    if (mailFrom)
      this.part("mailFromAttributes", {
        emailIdentity: identity.emailIdentity,
        mailFromDomain: mailFrom.domain,
        behaviorOnMxFailure: mailFrom.rejectOnMxFailure
          ? "REJECT_MESSAGE"
          : "USE_DEFAULT_VALUE",
      });

    for (const event of events)
      this.part("event", event.name as string, {
        configurationSetName: configurationSet.configurationSetName,
        eventDestinationName: event.name,
        eventDestination: {
          matchingEventTypes: output(event.types).apply((types) =>
            types.map((type) => type.toUpperCase().replaceAll("-", "_")),
          ),
          ...(event.bus
            ? { eventBridgeDestination: { eventBusArn: event.bus } }
            : {}),
          ...(event.topic ? { snsDestination: { topicArn: event.topic } } : {}),
          enabled: true,
        },
      });

    this.senderValue = output(sender);
    if (!isDomain) return;

    this.verifyDomain(sender, identity, dns, args.dmarc, mailFrom);
  }

  // A domain is verified with DNS records: DKIM, DMARC, and the records of a
  // custom MAIL FROM domain. SES checks for them, and the verification part
  // waits until it has.
  private verifyDomain(
    sender: string,
    identity: sesv2.EmailIdentity,
    dns: EmailArgs["dns"],
    dmarc: Input<string> | undefined,
    mailFrom: { domain: string } | undefined,
  ) {
    const name = this.componentName;
    const adapter = dns ?? awsDns();
    if (adapter) {
      // The tokens are only known once the identity is created
      identity.dkimSigningAttributes.tokens.apply(
        (tokens) =>
          tokens?.forEach((token) =>
            adapter.createRecord(
              name,
              {
                type: "CNAME",
                name: `${token}._domainkey.${sender}`,
                value: `${token}.dkim.amazonses.com`,
              },
              this.delegateOpts(),
            ),
          ),
      );
      adapter.createRecord(
        name,
        {
          type: "TXT",
          name: `_dmarc.${sender}`,
          value: dmarc ?? "v=DMARC1; p=none;",
        },
        this.delegateOpts(),
      );
      if (mailFrom) {
        const region = getRegionOutput(undefined, { parent: this }).region;
        adapter.createRecord(
          name,
          {
            type: "MX",
            name: mailFrom.domain,
            value: interpolate`feedback-smtp.${region}.amazonses.com`,
            priority: 10,
          },
          this.delegateOpts(),
        );
        adapter.createRecord(
          name,
          {
            type: "TXT",
            name: mailFrom.domain,
            value: "v=spf1 include:amazonses.com ~all",
          },
          this.delegateOpts(),
        );
      }
    }

    this.part("verification", { domain: sender }, { dependsOn: [identity] });
  }

  /**
   * The sender email address or domain name.
   */
  public get sender() {
    return this.senderValue;
  }

  /**
   * The name of the configuration set.
   */
  public get configSet() {
    return this.nodes.configurationSet.configurationSetName;
  }

  /**
   * Linking an email gives the linked resource the sender and the
   * configuration set, and permission to send with them.
   */
  public link() {
    return {
      properties: { sender: this.sender, configSet: this.configSet },
      include: [
        permission({
          actions: ["ses:*"],
          resources: [this.nodes.identity.arn, this.nodes.configurationSet.arn],
        }),
        // When the SES account is in sandbox mode, it seems you have to include verified
        // receipients inside `resources`. Needs further investigation.
        permission({
          actions: [
            "ses:SendEmail",
            "ses:SendRawEmail",
            "ses:SendTemplatedEmail",
          ],
          resources: ["*"],
        }),
      ],
    };
  }

  /**
   * Reference an existing Email component with the given Amazon SES identity. This is useful
   * when you create an SES identity in one stage and want to share it in another stage. It
   * avoids having to create a new Email component in the other stage.
   *
   * @param name The name of the component.
   * @param sender The email address or domain name of the existing SES identity.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create an Email component in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new component, you want to share the one from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const email = $app.stage === "frank"
   *   ? sst.aws.v5.Email.get("MyEmail", "spongebob@example.com")
   *   : new sst.aws.v5.Email("MyEmail", {
   *       sender: "spongebob@example.com",
   *     });
   * ```
   */
  public static get(
    name: string,
    sender: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Email(
      name,
      { existing: { identity: sender } } as EmailArgs,
      opts,
    );
  }
}
