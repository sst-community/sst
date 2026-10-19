import { Hono } from "hono";
import { handle, type LambdaContext, type LambdaEvent } from "@hono/aws-lambda";
import { ALL_SCOPE, CLAIMS, PLATFORM_ADMIN_SCOPE, scopeOf } from "../config";
import { saasApp, type SaasAppOptions } from "./app";
import { lazySetup } from "./env";
import type { Membership, Store, User } from "./store/types";

/** What Cognito sends a trigger. Only what's read here. */
export interface CognitoTriggerEvent {
  version: string;
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: {
    userAttributes: Record<string, string>;
    /** In a custom message: the placeholder Cognito replaces with the code. */
    codeParameter?: string;
    /** In a custom message to a user an admin created: the placeholder for the username. */
    usernameParameter?: string;
  };
  response: Record<string, unknown>;
}

/** Claims to add to both tokens. */
export type Claims = Record<string, string | number | boolean>;

export interface ClaimsInput {
  user: User;
  /** The tenant the tokens are for. */
  tenantId?: string;
  role?: string;
  membership?: Membership;
  store: Store;
  event: CognitoTriggerEvent;
}

export interface HandlerOptions extends SaasAppOptions {
  /**
   * Claims of your own for both tokens, like the tenant's plan. Keep it to
   * a read or two: Cognito gives the trigger 5 seconds.
   */
  claims?(input: ClaimsInput): Claims | Promise<Claims>;
}

/**
 * The three functions the component deploys. To change what they do, export
 * these from a file of your own and give the component its path as
 * `handlers`:
 *
 * ```ts title="src/saas.ts"
 * export const { api, postConfirmation, preTokenGeneration } = createHandlers({
 *   hooks: { tenantCreated: async ({ tenant }) => { ... } },
 *   claims: async ({ user }) => ({ plan: user.metadata?.plan ?? "free" }),
 * });
 * ```
 */
export function createHandlers(options: HandlerOptions = {}) {
  const setup = lazySetup(options);
  let api: ReturnType<typeof handle> | undefined;

  return {
    /** The built-in routes, under the component's `path`. */
    api(event: LambdaEvent, context?: LambdaContext) {
      if (!api) {
        const { config } = setup();
        api = handle(
          new Hono().route(config.path || "/", saasApp(options)).notFound((c) =>
            c.json(
              {
                error: { code: "not_found", message: "There's no such route." },
              },
              404,
            ),
          ),
        );
      }
      return api(event, context);
    },

    /**
     * Writes the emails Cognito sends, from the same templates as the app's:
     * the sign-up code, a password reset, a new user's temporary password,
     * a changed email's code and a sign-in code. Deployed when the component
     * has `email`.
     */
    async customMessage(event: CognitoTriggerEvent) {
      const { config, mail } = setup();
      if (!mail || !config.email) return event;
      const { app, templates } = mail;
      const attributes = event.request.userAttributes;
      const user = { email: attributes.email, name: attributes.name };
      const code = event.request.codeParameter ?? "{####}";
      const username = event.request.usernameParameter ?? "{username}";

      const message = (() => {
        switch (event.triggerSource) {
          case "CustomMessage_SignUp":
          case "CustomMessage_ResendCode":
            return templates.signUp({ code, user, app });
          case "CustomMessage_ForgotPassword":
            return templates.forgotPassword({ code, user, app });
          case "CustomMessage_AdminCreateUser":
            return templates.adminInvitation({
              username,
              password: code,
              user,
              app,
            });
          case "CustomMessage_UpdateUserAttribute":
          case "CustomMessage_VerifyUserAttribute":
            return templates.verifyEmail({ code, user, app });
          case "CustomMessage_Authentication":
            return templates.signInCode({ code, user, app });
        }
      })();
      if (!message) return event;

      // Cognito refuses a message without its placeholders. Its own is
      // better than none.
      const needs =
        event.triggerSource === "CustomMessage_AdminCreateUser"
          ? [code, username]
          : [code];
      const missing = needs.filter((part) => !message.html.includes(part));
      if (missing.length > 0) {
        console.error(
          `The "${event.triggerSource}" email leaves out ${missing.join(
            " and ",
          )}, so Cognito sends its own.`,
        );
        return event;
      }
      event.response = {
        ...event.response,
        emailSubject: message.subject,
        emailMessage: message.html,
      };
      return event;
    },

    /** Creates the user, and their own tenant, once they've confirmed their account. */
    async postConfirmation(event: CognitoTriggerEvent) {
      if (event.triggerSource === "PostConfirmation_ConfirmSignUp")
        await setup().tenancy.provision(identityOf(event));
      return event;
    },

    /**
     * Adds the tenant, the user's role in it and whether they're a platform
     * admin to both tokens, and the scopes of the role's permissions to the
     * access token. Creates the user when they're new, so a user the other
     * trigger missed gets created here.
     */
    async preTokenGeneration(event: CognitoTriggerEvent) {
      const { store, tenancy } = setup();
      const session = await tenancy.session(identityOf(event));
      const { user, tenantId, role, membership, permissions } = session;

      const claims: Claims = {};
      if (tenantId && role) {
        claims[CLAIMS.tenant] = tenantId;
        claims[CLAIMS.role] = role;
      }
      if (user.platformAdmin) claims[CLAIMS.platformAdmin] = "true";
      Object.assign(
        claims,
        await options.claims?.({
          user,
          tenantId,
          role,
          membership,
          store,
          event,
        }),
      );

      const scopes = [
        ...(permissions === "*" ? [ALL_SCOPE] : [...permissions].map(scopeOf)),
        ...(user.platformAdmin ? [PLATFORM_ADMIN_SCOPE] : []),
      ];

      // Version 1 of the event can only add claims to the ID token, as text
      if (event.version === "1") {
        event.response = {
          claimsOverrideDetails: {
            claimsToAddOrOverride: Object.fromEntries(
              Object.entries(claims).map(([k, v]) => [k, String(v)]),
            ),
          },
        };
        return event;
      }
      event.response = {
        claimsAndScopeOverrideDetails: {
          idTokenGeneration: { claimsToAddOrOverride: claims },
          accessTokenGeneration: {
            claimsToAddOrOverride: claims,
            scopesToAdd: scopes,
          },
        },
      };
      return event;
    },
  };
}

// Members are added by email, so only a verified one is kept
function identityOf(event: CognitoTriggerEvent) {
  const attributes = event.request.userAttributes;
  return {
    id: attributes.sub,
    email: attributes.email_verified === "true" ? attributes.email : undefined,
    name: attributes.name,
  };
}
