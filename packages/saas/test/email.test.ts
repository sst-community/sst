import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGES, type EmailConfig } from "../src/config";
import {
  defaultTemplates,
  escape,
  sesSender,
  type Mail,
} from "../src/runtime/email";
import { createMailer } from "../src/runtime/env";
import {
  createHandlers,
  type CognitoTriggerEvent,
} from "../src/runtime/handlers";
import { memoryStore } from "../src/runtime/store/memory";
import { config } from "./helpers";

const email = (patch: Partial<EmailConfig> = {}): EmailConfig => ({
  from: "Acme <hello@acme.com>",
  replyTo: "support@acme.com",
  configurationSet: "acme-set",
  appName: "Acme",
  url: "https://app.acme.com",
  messages: DEFAULT_MESSAGES,
  ...patch,
});

const app = { name: "Acme", url: "https://app.acme.com" };
const user = (id: string, email?: string) => ({
  id,
  email,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  createdAt: "",
  updatedAt: "",
});

describe("the templates", () => {
  it("escape what people wrote, in the HTML", () => {
    const tenant = {
      ...user("t"),
      name: `<script>alert(1)</script>`,
      createdBy: "ann",
    };
    const message = defaultTemplates.memberAdded({
      user: user("bob"),
      tenant,
      role: "member",
      by: user("ann"),
      app,
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
      const message = defaultTemplates[template]({
        code: "{####}",
        user: {},
        app,
      });
      expect(message.html, template).toContain("{####}");
      expect(message.text, template).toContain("{####}");
    }
    const invitation = defaultTemplates.adminInvitation({
      username: "{username}",
      password: "{####}",
      user: {},
      app,
    });
    expect(invitation.html).toContain("{username}");
    expect(invitation.html).toContain("{####}");
  });

  it("link to the app when there's a URL", () => {
    expect(defaultTemplates.welcome({ user: user("ann"), app }).html).toContain(
      `href="https://app.acme.com"`,
    );
    expect(
      defaultTemplates.welcome({ user: user("ann"), app: { name: "Acme" } })
        .html,
    ).not.toContain("href");
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
    const { tenancy } = await import("../src/runtime/tenancy");
    const { composeHooks, emailHooks, mailer } = await import(
      "../src/runtime/email"
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
    const { tenancy } = await import("../src/runtime/tenancy");
    const { composeHooks, emailHooks, mailer } = await import(
      "../src/runtime/email"
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
    const { tenancy } = await import("../src/runtime/tenancy");
    const { composeHooks, emailHooks, mailer } = await import(
      "../src/runtime/email"
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
      ...mail.templates.welcome({ user: user("ann"), app: mail.app }),
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
