import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { EmailConfig, Roles } from "../config";
import { allows, permissionsOf } from "./roles";
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

/** The app, as the emails name and show it. */
export interface App {
  name: string;
  /** Where the emails link to. */
  url?: string;
  /** The URL of the image at the top of each email. */
  logo?: string;
  /** The color of the links, like `"#2563eb"`. */
  color?: string;
}

/** Who an email is to, as the user pool knows them. */
export interface Person {
  email?: string;
  name?: string;
}

/** What an email says, before the layout puts it together. */
export interface Body {
  /** The heading, as HTML: escape what people wrote in it. */
  heading: string;
  /** The paragraphs, as HTML. */
  html: string[];
  /** The same paragraphs, as text. */
  text: string[];
  /**
   * The link at the end. "Open" the app, at its URL, unless it's given one,
   * or `false` for none.
   */
  action?: { label: string; url: string } | false;
}

/**
 * Puts an email together from what it says: the HTML and the text. Every
 * email goes through it, the built-in ones and yours, so a layout of your
 * own changes how they all look.
 */
export type Layout = (input: Body & { app: App }) => Omit<Message, "subject">;

/** What every template is given, as well as its own values. */
export interface TemplateContext {
  app: App;
  /** The layout, with the app filled in. */
  layout(body: Body): Omit<Message, "subject">;
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
  signUp(input: { code: string; user: Person } & TemplateContext): Message;
  /** The code that resets a forgotten password. */
  forgotPassword(
    input: { code: string; user: Person } & TemplateContext,
  ): Message;
  /** The username and temporary password of a user an admin created. */
  adminInvitation(
    input: {
      username: string;
      password: string;
      user: Person;
    } & TemplateContext,
  ): Message;
  /** The code that confirms an email address the user changed to. */
  verifyEmail(input: { code: string; user: Person } & TemplateContext): Message;
  /** The code a user signs in with, by email or as a second factor. */
  signInCode(input: { code: string; user: Person } & TemplateContext): Message;

  /** To a user who has just signed up. Off by default. */
  welcome(input: { user: User } & TemplateContext): Message;
  /** To someone invited to a tenant, who may not have signed up. */
  invitation(
    input: {
      /** Where it's sent, and the email they join with. */
      email: string;
      tenant: Tenant;
      role: string;
      by: User;
      /** When it can no longer be taken up. */
      expiresAt: string;
    } & TemplateContext,
  ): Message;
  /** To someone who was added to a tenant, but not when they took up an invitation. */
  memberAdded(
    input: {
      user: User;
      tenant: Tenant;
      role: string;
      by: User;
    } & TemplateContext,
  ): Message;
  /** To a member whose role changed. */
  roleChanged(
    input: {
      user: User;
      tenant: Tenant;
      role: string;
      previousRole: string;
      by: User;
    } & TemplateContext,
  ): Message;
  /** To a member someone else removed. */
  memberRemoved(
    input: { user: User; tenant: Tenant; by: User } & TemplateContext,
  ): Message;
}

/** The templates, with the app and the layout filled in. */
export type BoundTemplates = {
  [K in keyof Templates]: (
    input: Omit<Parameters<Templates[K]>[0], keyof TemplateContext>,
  ) => Message;
};

/** Escape text for HTML. */
export function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The built-in layout: the logo, when the app has one, the heading, the
 * paragraphs and a link, in one plain column that reads in any email client.
 */
export const defaultLayout: Layout = ({ app, heading, html, text, action }) => {
  const link =
    action === false
      ? undefined
      : action ??
        (app.url ? { label: `Open ${app.name}`, url: app.url } : undefined);
  const color = escape(app.color ?? "#2563eb");
  return {
    html: [
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#111827;max-width:560px">`,
      app.logo
        ? `<img src="${escape(app.logo)}" alt="${escape(
            app.name,
          )}" height="40" style="display:block;height:40px;width:auto;border:0;margin:0 0 24px">`
        : "",
      `<h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>`,
      ...html.map((line) => `<p style="margin:0 0 12px">${line}</p>`),
      link
        ? `<p style="margin:24px 0 0"><a href="${escape(
            link.url,
          )}" style="color:${color}">${escape(link.label)}</a></p>`
        : "",
      `</div>`,
    ].join(""),
    text: [...text, ...(link ? [`${link.label}: ${link.url}`] : [])].join(
      "\n\n",
    ),
  };
};

const nameOf = (user: { name?: string; email?: string }) =>
  user.name || user.email || "Someone";

// "in 7 days", from now
function until(time: string) {
  const ms = Date.parse(time) - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}
const code = (value: string) =>
  `<strong style="font-size:24px;letter-spacing:4px">${value}</strong>`;

/** The templates the component uses unless it's given its own. */
export const defaultTemplates: Templates = {
  signUp: ({ code: value, app, layout }) => ({
    subject: `Your ${app.name} verification code`,
    ...layout({
      heading: `Confirm your email`,
      html: [
        `Enter this code to finish signing up for ${escape(app.name)}:`,
        code(value),
      ],
      text: [`Enter this code to finish signing up for ${app.name}: ${value}`],
    }),
  }),
  forgotPassword: ({ code: value, app, layout }) => ({
    subject: `Reset your ${app.name} password`,
    ...layout({
      heading: `Reset your password`,
      html: [
        `Enter this code to choose a new password:`,
        code(value),
        `If you didn't ask to reset it, you can ignore this email.`,
      ],
      text: [
        `Enter this code to choose a new password: ${value}`,
        `If you didn't ask to reset it, you can ignore this email.`,
      ],
    }),
  }),
  adminInvitation: ({ username, password, app, layout }) => ({
    subject: `Your ${app.name} account`,
    ...layout({
      heading: `You have an account on ${escape(app.name)}`,
      html: [
        `Your username is <strong>${username}</strong>, and your temporary password is:`,
        code(password),
        `You'll choose a password of your own when you first sign in.`,
      ],
      text: [
        `Your username is ${username}, and your temporary password is: ${password}`,
        `You'll choose a password of your own when you first sign in.`,
      ],
    }),
  }),
  verifyEmail: ({ code: value, app, layout }) => ({
    subject: `Confirm your new ${app.name} email`,
    ...layout({
      heading: `Confirm your email`,
      html: [`Enter this code to confirm your new email address:`, code(value)],
      text: [`Enter this code to confirm your new email address: ${value}`],
    }),
  }),
  signInCode: ({ code: value, app, layout }) => ({
    subject: `Your ${app.name} sign-in code`,
    ...layout({
      heading: `Sign in`,
      html: [`Enter this code to sign in to ${escape(app.name)}:`, code(value)],
      text: [`Enter this code to sign in to ${app.name}: ${value}`],
    }),
  }),

  welcome: ({ user, app, layout }) => ({
    subject: `Welcome to ${app.name}`,
    ...layout({
      heading: `Welcome${user.name ? `, ${escape(user.name)}` : ""}`,
      html: [`Thanks for signing up for ${escape(app.name)}.`],
      text: [
        `Welcome${user.name ? `, ${user.name}` : ""}.`,
        `Thanks for signing up for ${app.name}.`,
      ],
    }),
  }),
  invitation: ({ email, tenant, role, by, expiresAt, app, layout }) => ({
    subject: `You're invited to ${tenant.name} on ${app.name}`,
    ...layout({
      heading: `Join ${escape(tenant.name)}`,
      html: [
        `${escape(nameOf(by))} invited you to join <strong>${escape(
          tenant.name,
        )}</strong> on ${escape(app.name)}, as ${escape(role)}.`,
        `Sign up or sign in with <strong>${escape(
          email,
        )}</strong> to join. The invitation expires ${until(expiresAt)}.`,
        `If you weren't expecting it, you can ignore this email.`,
      ],
      text: [
        `${nameOf(by)} invited you to join ${tenant.name} on ${
          app.name
        }, as ${role}.`,
        `Sign up or sign in with ${email} to join. The invitation expires ${until(
          expiresAt,
        )}.`,
        `If you weren't expecting it, you can ignore this email.`,
      ],
    }),
  }),
  memberAdded: ({ tenant, role, by, app, layout }) => ({
    subject: `You were added to ${tenant.name} on ${app.name}`,
    ...layout({
      heading: `You were added to ${escape(tenant.name)}`,
      html: [
        `${escape(nameOf(by))} added you to <strong>${escape(
          tenant.name,
        )}</strong> on ${escape(app.name)}, as ${escape(role)}.`,
      ],
      text: [
        `${nameOf(by)} added you to ${tenant.name} on ${app.name}, as ${role}.`,
      ],
    }),
  }),
  roleChanged: ({ tenant, role, previousRole, by, layout }) => ({
    subject: `Your role in ${tenant.name} changed`,
    ...layout({
      heading: `Your role in ${escape(tenant.name)} changed`,
      html: [
        `${escape(nameOf(by))} changed your role in <strong>${escape(
          tenant.name,
        )}</strong> from ${escape(previousRole)} to ${escape(role)}.`,
      ],
      text: [
        `${nameOf(by)} changed your role in ${
          tenant.name
        } from ${previousRole} to ${role}.`,
      ],
    }),
  }),
  memberRemoved: ({ tenant, by, app, layout }) => ({
    subject: `You were removed from ${tenant.name}`,
    ...layout({
      heading: `You were removed from ${escape(tenant.name)}`,
      html: [
        `${escape(nameOf(by))} removed you from <strong>${escape(
          tenant.name,
        )}</strong> on ${escape(app.name)}.`,
      ],
      text: [`${nameOf(by)} removed you from ${tenant.name} on ${app.name}.`],
    }),
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
  /** A layout of your own, for every email. */
  layout?: Layout;
}

/** Who `notify()` sends to. */
export type Recipients =
  | { userIds: string[] }
  /** A tenant's members, or only those whose role has the permission. */
  | { tenantId: string; permission?: string };

export interface NotifyInput {
  to: Recipients;
  /** The email to each of them, or nothing to leave one out. */
  message(user: User): Message | undefined | Promise<Message | undefined>;
}

export interface NotifyResult {
  sent: User[];
  /** No verified email, or no message for them. */
  skipped: User[];
  failed: { user: User; error: unknown }[];
}

export interface Mailer {
  app: App;
  templates: BoundTemplates;
  /** Put an email of your own together, in the same layout as the built-in ones. */
  layout(body: Body): Omit<Message, "subject">;
  /** Send an email, with the component's reply-to address unless it has one. */
  send(mail: Mail): Promise<void>;
  /**
   * Email users, or a tenant's members, at their verified email. It sends
   * one at a time and keeps going when one fails: for a great many, send
   * from a queue.
   */
  notify(input: NotifyInput): Promise<NotifyResult>;
}

/** Where `notify()` finds users and their roles. */
export interface Directory {
  store(): Store;
  roles: Roles;
}

/**
 * What sends the emails, with the templates. It's made from the component's
 * `email` config, and takes a sender, templates and a layout of your own.
 * `createMailer()` makes one from what the component set up.
 */
export function mailer(
  config: EmailConfig,
  args: MailerArgs = {},
  directory?: Directory,
): Mailer {
  const send = args.send ?? sesSender(config);
  const app: App = {
    name: config.appName,
    url: config.url,
    logo: config.logo,
    color: config.color,
  };
  const layout = (body: Body) =>
    (args.layout ?? defaultLayout)({ ...body, app });
  const templates = { ...defaultTemplates, ...args.templates };
  const bound = Object.fromEntries(
    Object.entries(templates).map(([name, template]) => [
      name,
      (input: object) => (template as any)({ ...input, app, layout }),
    ]),
  ) as BoundTemplates;
  const deliver: Mailer["send"] = (mail) =>
    send({ ...mail, replyTo: mail.replyTo ?? config.replyTo });

  return {
    app,
    templates: bound,
    layout,
    send: deliver,
    async notify({ to, message }) {
      if (!directory)
        throw new Error(
          `This mailer has no store to find users in. Make it with createMailer().`,
        );
      const store = directory.store();
      let users: User[];
      if ("userIds" in to)
        users = await store.getUsers([...new Set(to.userIds)]);
      else {
        const members = (await store.listMembers(to.tenantId)).filter(
          (m) =>
            to.permission === undefined ||
            allows(permissionsOf(directory.roles, m.role), to.permission),
        );
        users = await store.getUsers(members.map((m) => m.userId));
      }

      const result: NotifyResult = { sent: [], skipped: [], failed: [] };
      for (const user of users) {
        try {
          const content = user.email ? await message(user) : undefined;
          if (!content) {
            result.skipped.push(user);
            continue;
          }
          await deliver({ to: user.email!, ...content });
          result.sent.push(user);
        } catch (error) {
          result.failed.push({ user, error });
        }
      }
      return result;
    },
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
  const { templates } = mail;
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
        await deliver(user.email, () => templates.welcome({ user }));
    },
    async invitationCreated({ invitation, tenant, by }) {
      if (!messages.invitation) return;
      await deliver(invitation.email, () =>
        templates.invitation({
          email: invitation.email,
          tenant,
          role: invitation.role,
          by,
          expiresAt: invitation.expiresAt,
        }),
      );
    },
    async memberAdded({ membership, by, invitation }) {
      // Not to someone who took up an invitation: they were told
      if (!messages.memberAdded || invitation) return;
      const [user, tenant] = await both(membership.userId, membership.tenantId);
      if (user && tenant)
        await deliver(user.email, () =>
          templates.memberAdded({ user, tenant, role: membership.role, by }),
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
          }),
        );
    },
    async memberRemoved({ membership, by }) {
      // Not to someone who left
      if (!messages.memberRemoved || membership.userId === by.id) return;
      const [user, tenant] = await both(membership.userId, membership.tenantId);
      if (user && tenant)
        await deliver(user.email, () =>
          templates.memberRemoved({ user, tenant, by }),
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
