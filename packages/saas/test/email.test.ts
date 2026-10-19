import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGES, type EmailConfig } from "../src/config.js";
import {
  escape,
  mailer,
  sesSender,
  type Layout,
  type Mail,
  type Templates,
} from "../src/runtime/email.js";
import { createMailer } from "../src/runtime/env.js";
import {
  createHandlers,
  type CognitoTriggerEvent,
} from "../src/runtime/handlers.js";
import { memoryStore } from "../src/runtime/store/memory.js";
import { config } from "./helpers.js";

const email = (patch: Partial<EmailConfig> = {}): EmailConfig => ({
  from: "Acme <hello@acme.com>",
  replyTo: "support@acme.com",
  configurationSet: "acme-set",
  appName: "Acme",
  url: "https://app.acme.com",
  messages: DEFAULT_MESSAGES,
  ...patch,
});

const user = (id: string, email?: string) => ({
  id,
  email,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  createdAt: "",
  updatedAt: "",
});

describe("the templates", () => {
  // The templates, with the app and the layout filled in
  const templates = (patch: Partial<EmailConfig> = {}, args = {}) =>
    mailer(email(patch), { send: async () => {}, ...args }).templates;

  it("escape what people wrote, in the HTML", () => {
    const tenant = {
      ...user("t"),
      name: `<script>alert(1)</script>`,
      createdBy: "ann",
    };
    const message = templates().memberAdded({
      user: user("bob"),
      tenant,
      role: "member",
      by: user("ann"),
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain(escape(tenant.name));
    // The text and the subject aren't HTML
    expect(message.text).toContain(tenant.name);
    expect(message.subject).toBe(`You were added to ${tenant.name} on Acme`);
  });

  it("include Cognito's placeholders", () => {
    for (const template of [
      "signUp",
      "forgotPassword",
      "verifyEmail",
      "signInCode",
    ] as const) {
      const message = templates()[template]({ code: "{####}", user: {} });
      expect(message.html, template).toContain("{####}");
      expect(message.text, template).toContain("{####}");
    }
    const invitation = templates().adminInvitation({
      username: "{username}",
      password: "{####}",
      user: {},
    });
    expect(invitation.html).toContain("{username}");
    expect(invitation.html).toContain("{####}");
  });

  it("say who invited them, with which email to join and when it expires", () => {
    const tenant = { ...user("t"), name: "Acme & Co", createdBy: "ann" };
    const message = templates().invitation({
      email: "dan@example.com",
      tenant,
      role: "admin",
      by: user("ann"),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(message.subject).toBe("You're invited to Acme & Co on Acme");
    expect(message.text).toContain(
      "Ann invited you to join Acme & Co on Acme, as admin.",
    );
    expect(message.text).toContain(
      "Sign up or sign in with dan@example.com to join. The invitation expires in 7 days.",
    );
    expect(message.html).toContain("Acme &amp; Co");
    expect(message.html).toContain(`href="https://app.acme.com"`);
  });

  it("link to the app when there's a URL", () => {
    const welcome = templates().welcome({ user: user("ann") });
    expect(welcome.html).toContain(`href="https://app.acme.com"`);
    expect(welcome.text).toContain("Open Acme: https://app.acme.com");
    expect(
      templates({ url: undefined }).welcome({ user: user("ann") }).html,
    ).not.toContain("href");
  });

  it("show the app's logo, with its links in its color", () => {
    const { html } = templates({
      logo: "https://acme.com/logo.png?v=1&size=2",
      color: "#ff6600",
    }).welcome({ user: user("ann") });
    expect(html).toContain(
      `<img src="https://acme.com/logo.png?v=1&amp;size=2" alt="Acme" height="40"`,
    );
    expect(html).toContain(`style="color:#ff6600"`);
    expect(templates().welcome({ user: user("ann") }).html).not.toContain(
      "<img",
    );
  });

  it("are put together by a layout of your own, Cognito's too", () => {
    const layout: Layout = ({ app, heading, html, text }) => ({
      html: `<main data-app="${app.name}"><h2>${heading}</h2>${html.join(
        "",
      )}</main>`,
      text: text.join("\n"),
    });
    const own = templates({}, { layout });
    expect(own.welcome({ user: user("ann") }).html).toBe(
      `<main data-app="Acme"><h2>Welcome, Ann</h2>Thanks for signing up for Acme.</main>`,
    );
    expect(own.signUp({ code: "{####}", user: {} }).html).toContain("{####}");
  });

  it("can be replaced, and the replacement gets the layout", () => {
    const own = templates(
      {},
      {
        templates: {
          welcome: ({ user, layout }) => ({
            subject: "Hi",
            ...layout({
              heading: `Hi ${escape(user.name ?? "")}`,
              html: ["Glad you're here."],
              text: ["Glad you're here."],
            }),
          }),
        } satisfies Partial<Templates>,
      },
    );
    const message = own.welcome({ user: user("ann") });
    expect(message.subject).toBe("Hi");
    expect(message.html).toContain(`href="https://app.acme.com"`);
  });
});

describe("mail.layout()", () => {
  const mail = mailer(email({ logo: "https://acme.com/logo.png" }), {
    send: async () => {},
  });

  it("puts an email of your own in the same layout", () => {
    const { html, text } = mail.layout({
      heading: "Your invoice is ready",
      html: ["It's for <strong>October</strong>."],
      text: ["It's for October."],
      action: { label: "View it", url: "https://app.acme.com/invoices/1" },
    });
    expect(html).toContain(`<img src="https://acme.com/logo.png"`);
    expect(html).toContain("<h1");
    expect(html).toContain(
      `<a href="https://app.acme.com/invoices/1" style="color:#2563eb">View it</a>`,
    );
    expect(text).toBe(
      "It's for October.\n\nView it: https://app.acme.com/invoices/1",
    );
  });

  it("leaves the link out when it's told to", () => {
    const { html, text } = mail.layout({
      heading: "Done",
      html: ["Done."],
      text: ["Done."],
      action: false,
    });
    expect(html).not.toContain("<a ");
    expect(text).toBe("Done.");
  });
});

describe("the custom message trigger", () => {
  const event = (triggerSource: string): CognitoTriggerEvent => ({
    version: "1",
    triggerSource,
    userPoolId: "us-west-2_abc",
    userName: "ann",
    request: {
      userAttributes: { sub: "ann", email: "ann@example.com", name: "Ann" },
      codeParameter: "{####}",
      usernameParameter: "{username}",
    },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  });
  const handlers = (templates = {}) =>
    createHandlers({
      store: memoryStore(),
      config: config({ email: email() }),
      email: { send: async () => {}, templates },
    });

  it("writes each of Cognito's emails from its template", async () => {
    const { customMessage } = handlers();
    const subjects: Record<string, string> = {
      CustomMessage_SignUp: "Your Acme verification code",
      CustomMessage_ResendCode: "Your Acme verification code",
      CustomMessage_ForgotPassword: "Reset your Acme password",
      CustomMessage_AdminCreateUser: "Your Acme account",
      CustomMessage_UpdateUserAttribute: "Confirm your new Acme email",
      CustomMessage_VerifyUserAttribute: "Confirm your new Acme email",
      CustomMessage_Authentication: "Your Acme sign-in code",
    };
    for (const [source, subject] of Object.entries(subjects)) {
      const result = await customMessage(event(source));
      expect(result.response.emailSubject, source).toBe(subject);
      expect(result.response.emailMessage, source).toContain("{####}");
    }
  });

  it("leaves a message it has no template for to Cognito", async () => {
    const result = await handlers().customMessage(event("CustomMessage_Other"));
    expect(result.response.emailMessage).toBeNull();
  });

  it("lets Cognito send its own when a template leaves out the code", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { customMessage } = handlers({
      signUp: () => ({ subject: "Hi", html: "No code here", text: "" }),
    });
    const result = await customMessage(event("CustomMessage_SignUp"));
    expect(result.response.emailMessage).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("leaves out {####}"),
    );
    error.mockRestore();
  });

  it("does nothing without email in the config", async () => {
    const { customMessage } = createHandlers({
      store: memoryStore(),
      config: config(),
    });
    const result = await customMessage(event("CustomMessage_SignUp"));
    expect(result.response.emailSubject).toBeNull();
  });
});

describe("the app's emails", () => {
  let sent: Mail[];
  let store: ReturnType<typeof memoryStore>;
  const send = async (mail: Mail) => {
    sent.push(mail);
  };
  const setup = (patch: Partial<EmailConfig> = {}) => {
    const { postConfirmation, api } = createHandlers({
      store,
      config: config({ email: email(patch) }),
      email: { send },
    });
    return { postConfirmation, api };
  };
  const signUp = (handlers: ReturnType<typeof setup>, id: string) =>
    handlers.postConfirmation({
      version: "1",
      triggerSource: "PostConfirmation_ConfirmSignUp",
      userPoolId: "us-west-2_abc",
      userName: id,
      request: {
        userAttributes: {
          sub: id,
          email: `${id}@example.com`,
          email_verified: "true",
          name: id,
        },
      },
      response: {},
    });

  beforeEach(() => {
    sent = [];
    store = memoryStore();
  });

  // The routes, through tenancy, with the same setup the handlers have
  async function team(patch: Partial<EmailConfig> = {}) {
    const { tenancy } = await import("../src/runtime/tenancy.js");
    const { composeHooks, emailHooks, mailer } = await import(
      "../src/runtime/email.js"
    );
    const mail = mailer(email(patch), { send });
    const t = tenancy({
      store,
      config: config({ email: email(patch) }),
      hooks: composeHooks(emailHooks(mail, store, email(patch).messages)),
    });
    await t.provision({ id: "ann", email: "ann@example.com", name: "Ann" });
    await t.provision({ id: "bob", email: "bob@example.com", name: "Bob" });
    const tenant = await t.createTenant({ id: "ann" }, { name: "Acme" });
    sent = [];
    return { t, tenantId: tenant.id };
  }

  it("tell a member they were added, their role changed, and they were removed", async () => {
    const { t, tenantId } = await team();
    await t.addMember({ id: "ann" }, tenantId, { userId: "bob" });
    await t.changeRole({ id: "ann" }, tenantId, "bob", { role: "admin" });
    await t.removeMember({ id: "ann" }, tenantId, "bob");

    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ["bob@example.com", "You were added to Acme on Acme"],
      ["bob@example.com", "Your role in Acme changed"],
      ["bob@example.com", "You were removed from Acme"],
    ]);
    expect(sent[1].text).toContain("from member to admin");
    expect(sent[0].replyTo).toBe("support@acme.com");
  });

  it("invite someone, who isn't told again that they were added when they join", async () => {
    const { t, tenantId } = await team();
    await t.invite({ id: "ann" }, tenantId, { email: "dan@example.com" });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ["dan@example.com", "You're invited to Acme on Acme"],
    ]);
    expect(sent[0].text).toContain("Ann invited you to join Acme on Acme");

    sent = [];
    await t.provision({ id: "dan", email: "dan@example.com" });
    expect(await store.getMembership(tenantId, "dan")).toBeDefined();
    expect(sent).toEqual([]);
  });

  it("don't send an invitation when it's turned off", async () => {
    const { t, tenantId } = await team({
      messages: { ...DEFAULT_MESSAGES, invitation: false },
    });
    await t.invite({ id: "ann" }, tenantId, { email: "dan@example.com" });
    expect(sent).toEqual([]);
    expect(
      await store.getInvitation(tenantId, "dan@example.com"),
    ).toBeDefined();
  });

  it("don't tell someone who left", async () => {
    const { t, tenantId } = await team();
    await t.addMember({ id: "ann" }, tenantId, { userId: "bob" });
    sent = [];
    await t.removeMember({ id: "bob" }, tenantId, "bob");
    expect(sent).toEqual([]);
  });

  it("are each turned off in the config", async () => {
    const { t, tenantId } = await team({
      messages: { ...DEFAULT_MESSAGES, memberAdded: false },
    });
    await t.addMember({ id: "ann" }, tenantId, { userId: "bob" });
    expect(sent).toEqual([]);
  });

  it("welcome a new user only when it's on", async () => {
    await signUp(setup(), "cat");
    expect(sent).toEqual([]);

    await signUp(
      setup({ messages: { ...DEFAULT_MESSAGES, welcome: true } }),
      "dan",
    );
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ["dan@example.com", "Welcome to Acme"],
    ]);
  });

  it("don't fail the change when sending fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tenancy } = await import("../src/runtime/tenancy.js");
    const { composeHooks, emailHooks, mailer } = await import(
      "../src/runtime/email.js"
    );
    const failing = mailer(email(), {
      send: async () => {
        throw new Error("SES is down");
      },
    });
    const t = tenancy({
      store,
      config: config({ email: email() }),
      hooks: composeHooks(emailHooks(failing, store, DEFAULT_MESSAGES)),
    });
    await t.provision({ id: "ann", email: "ann@example.com" });
    await t.provision({ id: "bob", email: "bob@example.com" });
    const tenant = await t.createTenant({ id: "ann" }, { name: "Acme" });

    await expect(
      t.addMember({ id: "ann" }, tenant.id, { userId: "bob" }),
    ).resolves.toBeTruthy();
    expect(await store.getMembership(tenant.id, "bob")).toBeDefined();
    expect(error).toHaveBeenCalledWith(
      "Couldn't send an email to bob@example.com:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("run before your own hooks", async () => {
    const order: string[] = [];
    const { tenancy } = await import("../src/runtime/tenancy.js");
    const { composeHooks, emailHooks, mailer } = await import(
      "../src/runtime/email.js"
    );
    const mail = mailer(email(), {
      send: async () => void order.push("email"),
    });
    const t = tenancy({
      store,
      config: config({ email: email() }),
      hooks: composeHooks(emailHooks(mail, store, DEFAULT_MESSAGES), {
        memberAdded: () => void order.push("yours"),
      }),
    });
    await t.provision({ id: "ann", email: "ann@example.com" });
    await t.provision({ id: "bob", email: "bob@example.com" });
    const tenant = await t.createTenant({ id: "ann" }, { name: "Acme" });
    await t.addMember({ id: "ann" }, tenant.id, { userId: "bob" });
    expect(order).toEqual(["email", "yours"]);
  });
});

describe("createMailer()", () => {
  it("sends with the component's templates and reply-to address", async () => {
    const sent: Mail[] = [];
    const mail = createMailer({
      config: config({ email: email() }),
      send: async (m) => void sent.push(m),
    });
    await mail.send({
      to: "ann@example.com",
      ...mail.templates.welcome({ user: user("ann") }),
    });
    expect(sent[0]).toMatchObject({
      to: "ann@example.com",
      subject: "Welcome to Acme",
      replyTo: "support@acme.com",
    });
  });

  it("says when the component has no email", () => {
    const mail = createMailer({ config: config() });
    expect(() => mail.templates).toThrow(`has no "email"`);
  });
});

describe("notify()", () => {
  let sent: Mail[];
  let store: ReturnType<typeof memoryStore>;
  let tenantId: string;
  const roles = {
    owner: ["*"],
    billing: ["tenant:read", "billing:read"],
    member: ["tenant:read"],
  };
  const notifier = () =>
    createMailer({
      config: config({ roles, email: email() }),
      store,
      send: async (mail) => {
        if (mail.to === "fails@example.com") throw new Error("SES is down");
        sent.push(mail);
      },
    });
  const note = (user: { name?: string }) => ({
    subject: "Your invoice is ready",
    html: `<p>Hi ${user.name}</p>`,
    text: `Hi ${user.name}`,
  });

  beforeEach(async () => {
    sent = [];
    store = memoryStore();
    const { tenancy } = await import("../src/runtime/tenancy.js");
    const t = tenancy({ store, config: config({ roles }) });
    await t.provision({ id: "ann", email: "ann@example.com", name: "Ann" });
    await t.provision({ id: "bob", email: "bob@example.com", name: "Bob" });
    await t.provision({ id: "cat", email: "cat@example.com", name: "Cat" });
    // No verified email
    await t.provision({ id: "dan", name: "Dan" });
    const tenant = await t.createTenant({ id: "ann" }, { name: "Acme" });
    tenantId = tenant.id;
    for (const [userId, role] of [
      ["bob", "billing"],
      ["cat", "member"],
      ["dan", "billing"],
    ])
      await t.addMember({ id: "ann" }, tenantId, { userId, role });
  });

  it("emails users by id, at their verified email", async () => {
    const result = await notifier().notify({
      to: { userIds: ["bob", "dan", "nobody", "bob"] },
      message: note,
    });
    expect(sent.map((m) => [m.to, m.text])).toEqual([
      ["bob@example.com", "Hi Bob"],
    ]);
    // With the component's reply-to address
    expect(sent[0].replyTo).toBe("support@acme.com");
    expect(result.sent.map((u) => u.id)).toEqual(["bob"]);
    expect(result.skipped.map((u) => u.id)).toEqual(["dan"]);
  });

  it("emails a tenant's members whose role has a permission", async () => {
    await notifier().notify({
      to: { tenantId, permission: "billing:read" },
      message: note,
    });
    // The owner's role has every permission
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ann@example.com",
      "bob@example.com",
    ]);

    sent = [];
    await notifier().notify({ to: { tenantId }, message: note });
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ann@example.com",
      "bob@example.com",
      "cat@example.com",
    ]);
  });

  it("leaves out whoever it has no message for, and keeps going when one fails", async () => {
    await store.updateUser("cat", { email: "fails@example.com" });
    const result = await notifier().notify({
      to: { tenantId },
      message: (user) => (user.id === "ann" ? undefined : note(user)),
    });
    expect(sent.map((m) => m.to)).toEqual(["bob@example.com"]);
    expect(result.skipped.map((u) => u.id).sort()).toEqual(["ann", "dan"]);
    expect(result.failed.map((f) => f.user.id)).toEqual(["cat"]);
    expect((result.failed[0].error as Error).message).toBe("SES is down");
  });

  it("needs a store", async () => {
    const mail = mailer(email(), { send: async () => {} });
    await expect(
      mail.notify({ to: { userIds: ["ann"] }, message: note }),
    ).rejects.toThrow("no store to find users in");
  });
});

describe("the SES sender", () => {
  it("sends the HTML and text from the configured address", async () => {
    const commands: any[] = [];
    const client = {
      send: async (command: any) => void commands.push(command.input),
    };
    await sesSender(
      email(),
      client as any,
    )({
      to: "ann@example.com",
      replyTo: "support@acme.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(commands[0]).toEqual({
      FromEmailAddress: "Acme <hello@acme.com>",
      Destination: { ToAddresses: ["ann@example.com"] },
      ReplyToAddresses: ["support@acme.com"],
      ConfigurationSetName: "acme-set",
      Content: {
        Simple: {
          Subject: { Data: "Hi", Charset: "UTF-8" },
          Body: {
            Html: { Data: "<p>Hi</p>", Charset: "UTF-8" },
            Text: { Data: "Hi", Charset: "UTF-8" },
          },
        },
      },
    });
  });
});
