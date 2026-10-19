import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { EmailConfig } from "../config";
import type { Store, Tenant, User } from "./store/types";
import type { TenancyHooks } from "./tenancy";

/** An email to send: its subject, and its body as HTML and as text. */
export interface Message {
  subject: string;
  html: string;
  text: string;
}

/** An email and who it goes to. */
export interface Mail extends Message {
  to: string;
  replyTo?: string;
}

/** Sends an email. The default sends with Amazon SES, from the component's `email.from`. */
export type Send = (mail: Mail) => Promise<void>;

/** The app, as the emails name it. */
export interface App {
  name: string;
  /** Where the emails link to. */
  url?: string;
}

/** Who an email is to, as the user pool knows them. */
export interface Person {
  email?: string;
  name?: string;
}

/**
 * The emails, each a function that returns its subject and body. Values the
 * templates are given that people wrote, like a tenant's name, have to be
 * escaped in the HTML: `escape()` does that.
 *
 * The first five are sent by Cognito, from the custom message trigger. Each
 * has to include the `code` it's given, which is a placeholder Cognito fills
 * in, and `adminInvitation` the `username` too.
 */
export interface Templates {
  /** The code that confirms a sign-up, and the same when it's sent again. */
  signUp(input: { code: string; user: Person; app: App }): Message;
  /** The code that resets a forgotten password. */
  forgotPassword(input: { code: string; user: Person; app: App }): Message;
  /** The username and temporary password of a user an admin created. */
  adminInvitation(input: {
    username: string;
    password: string;
    user: Person;
    app: App;
  }): Message;
  /** The code that confirms an email address the user changed to. */
  verifyEmail(input: { code: string; user: Person; app: App }): Message;
  /** The code a user signs in with, by email or as a second factor. */
  signInCode(input: { code: string; user: Person; app: App }): Message;

  /** To a user who has just signed up. Off by default. */
  welcome(input: { user: User; app: App }): Message;
  /** To someone who was added to a tenant. */
  memberAdded(input: {
    user: User;
    tenant: Tenant;
    role: string;
    by: User;
    app: App;
  }): Message;
  /** To a member whose role changed. */
  roleChanged(input: {
    user: User;
    tenant: Tenant;
    role: string;
    previousRole: string;
    by: User;
    app: App;
  }): Message;
  /** To a member someone else removed. */
  memberRemoved(input: {
    user: User;
    tenant: Tenant;
    by: User;
    app: App;
  }): Message;
}

/** Escape text for HTML. */
export function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A plain email: a heading, paragraphs, and a link to the app. `lines` are
// HTML; whatever people wrote in them is escaped by the caller.
function layout(
  app: App,
  heading: string,
  lines: string[],
  text: string[],
): Omit<Message, "subject"> {
  const link = app.url
    ? `<p style="margin:24px 0 0"><a href="${escape(
        app.url,
      )}" style="color:#2563eb">Open ${escape(app.name)}</a></p>`
    : "";
  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#111827;max-width:560px">`,
    `<h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>`,
    ...lines.map((line) => `<p style="margin:0 0 12px">${line}</p>`),
    link,
    `</div>`,
  ].join("");
  return {
    html,
    text: [...text, ...(app.url ? [`Open ${app.name}: ${app.url}`] : [])].join(
      "\n\n",
    ),
  };
}

const nameOf = (user: { name?: string; email?: string }) =>
  user.name || user.email || "Someone";
const code = (value: string) =>
  `<strong style="font-size:24px;letter-spacing:4px">${value}</strong>`;

/** The templates the component uses unless it's given its own. */
export const defaultTemplates: Templates = {
  signUp: ({ code: value, app }) => ({
    subject: `Your ${app.name} verification code`,
    ...layout(
      app,
      `Confirm your email`,
      [
        `Enter this code to finish signing up for ${escape(app.name)}:`,
        code(value),
      ],
      [`Enter this code to finish signing up for ${app.name}: ${value}`],
    ),
  }),
  forgotPassword: ({ code: value, app }) => ({
    subject: `Reset your ${app.name} password`,
    ...layout(
      app,
      `Reset your password`,
      [
        `Enter this code to choose a new password:`,
        code(value),
        `If you didn't ask to reset it, you can ignore this email.`,
      ],
      [
        `Enter this code to choose a new password: ${value}`,
        `If you didn't ask to reset it, you can ignore this email.`,
      ],
    ),
  }),
  adminInvitation: ({ username, password, app }) => ({
    subject: `Your ${app.name} account`,
    ...layout(
      app,
      `You have an account on ${escape(app.name)}`,
      [
        `Your username is <strong>${username}</strong>, and your temporary password is:`,
        code(password),
        `You'll choose a password of your own when you first sign in.`,
      ],
      [
        `Your username is ${username}, and your temporary password is: ${password}`,
        `You'll choose a password of your own when you first sign in.`,
      ],
    ),
  }),
  verifyEmail: ({ code: value, app }) => ({
    subject: `Confirm your new ${app.name} email`,
    ...layout(
      app,
      `Confirm your email`,
      [`Enter this code to confirm your new email address:`, code(value)],
      [`Enter this code to confirm your new email address: ${value}`],
    ),
  }),
  signInCode: ({ code: value, app }) => ({
    subject: `Your ${app.name} sign-in code`,
    ...layout(
      app,
      `Sign in`,
      [`Enter this code to sign in to ${escape(app.name)}:`, code(value)],
      [`Enter this code to sign in to ${app.name}: ${value}`],
    ),
  }),

  welcome: ({ user, app }) => ({
    subject: `Welcome to ${app.name}`,
    ...layout(
      app,
      `Welcome${user.name ? `, ${escape(user.name)}` : ""}`,
      [`Thanks for signing up for ${escape(app.name)}.`],
      [
        `Welcome${user.name ? `, ${user.name}` : ""}.`,
        `Thanks for signing up for ${app.name}.`,
      ],
    ),
  }),
  memberAdded: ({ tenant, role, by, app }) => ({
    subject: `You were added to ${tenant.name} on ${app.name}`,
    ...layout(
      app,
      `You were added to ${escape(tenant.name)}`,
      [
        `${escape(nameOf(by))} added you to <strong>${escape(
          tenant.name,
        )}</strong> on ${escape(app.name)}, as ${escape(role)}.`,
      ],
      [`${nameOf(by)} added you to ${tenant.name} on ${app.name}, as ${role}.`],
    ),
  }),
  roleChanged: ({ tenant, role, previousRole, by, app }) => ({
    subject: `Your role in ${tenant.name} changed`,
    ...layout(
      app,
      `Your role in ${escape(tenant.name)} changed`,
      [
        `${escape(nameOf(by))} changed your role in <strong>${escape(
          tenant.name,
        )}</strong> from ${escape(previousRole)} to ${escape(role)}.`,
      ],
      [
        `${nameOf(by)} changed your role in ${
          tenant.name
        } from ${previousRole} to ${role}.`,
      ],
    ),
  }),
  memberRemoved: ({ tenant, by, app }) => ({
    subject: `You were removed from ${tenant.name}`,
    ...layout(
      app,
      `You were removed from ${escape(tenant.name)}`,
      [
        `${escape(nameOf(by))} removed you from <strong>${escape(
          tenant.name,
        )}</strong> on ${escape(app.name)}.`,
      ],
      [`${nameOf(by)} removed you from ${tenant.name} on ${app.name}.`],
    ),
  }),
};

/** Sends with Amazon SES, from the address in the config. */
export function sesSender(
  config: Pick<EmailConfig, "from" | "configurationSet">,
  client?: SESv2Client,
): Send {
  return async (mail) => {
    client ??= new SESv2Client({});
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [mail.to] },
        ReplyToAddresses: mail.replyTo ? [mail.replyTo] : undefined,
        ConfigurationSetName: config.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: mail.html, Charset: "UTF-8" },
              Text: { Data: mail.text, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
  };
}

export interface MailerArgs {
  /** In place of sending with Amazon SES: another provider, or a test's. */
  send?: Send;
  /** Templates of your own, in place of any of the defaults. */
  templates?: Partial<Templates>;
}

export interface Mailer {
  app: App;
  templates: Templates;
  /** Send an email, with the component's reply-to address unless it has one. */
  send(mail: Mail): Promise<void>;
}

/**
 * What sends the emails, with the templates. It's made from the component's
 * `email` config, and takes a sender and templates of your own.
 *
 * ```ts
 * const mailer = createMailer();
 * await mailer.send({
 *   to: "ann@example.com",
 *   ...mailer.templates.welcome({ user, app: mailer.app }),
 * });
 * ```
 */
export function mailer(config: EmailConfig, args: MailerArgs = {}): Mailer {
  const send = args.send ?? sesSender(config);
  return {
    app: { name: config.appName, url: config.url },
    templates: { ...defaultTemplates, ...args.templates },
    send: (mail) => send({ ...mail, replyTo: mail.replyTo ?? config.replyTo }),
  };
}

/**
 * The hooks that send the built-in emails the config turns on. Each is sent
 * after its change is made. A send that fails is logged: the change it's
 * about is made all the same.
 */
export function emailHooks(
  mail: Mailer,
  store: Store,
  messages: EmailConfig["messages"],
): TenancyHooks {
  const { app, templates } = mail;
  const deliver = async (to: string | undefined, message: () => Message) => {
    if (!to) return;
    try {
      await mail.send({ to, ...message() });
    } catch (error) {
      console.error(`Couldn't send an email to ${to}:`, error);
    }
  };
  const both = (userId: string, tenantId: string) =>
    Promise.all([store.getUser(userId), store.getTenant(tenantId)]);

  return {
    async userCreated({ user }) {
      if (messages.welcome)
        await deliver(user.email, () => templates.welcome({ user, app }));
    },
    async memberAdded({ membership, by }) {
      if (!messages.memberAdded) return;
      const [user, tenant] = await both(membership.userId, membership.tenantId);
      if (user && tenant)
        await deliver(user.email, () =>
          templates.memberAdded({
            user,
            tenant,
            role: membership.role,
            by,
            app,
          }),
        );
    },
    async memberChanged({ membership, previous, by }) {
      if (!messages.roleChanged || membership.role === previous.role) return;
      const [user, tenant] = await both(membership.userId, membership.tenantId);
      if (user && tenant)
        await deliver(user.email, () =>
          templates.roleChanged({
            user,
            tenant,
            role: membership.role,
            previousRole: previous.role,
            by,
            app,
          }),
        );
    },
    async memberRemoved({ membership, by }) {
      // Not to someone who left
      if (!messages.memberRemoved || membership.userId === by.id) return;
      const [user, tenant] = await both(membership.userId, membership.tenantId);
      if (user && tenant)
        await deliver(user.email, () =>
          templates.memberRemoved({ user, tenant, by, app }),
        );
    },
  };
}

/** Runs the first hooks, then the second, for each change. */
export function composeHooks(
  first: TenancyHooks,
  second: TenancyHooks = {},
): TenancyHooks {
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]) as Set<
    keyof TenancyHooks
  >;
  const hooks: TenancyHooks = {};
  for (const key of keys)
    hooks[key] = async (event: any) => {
      await (first[key] as any)?.(event);
      await (second[key] as any)?.(event);
    };
  return hooks;
}
