import { CONFIG_ENV, type SaasConfig } from "../config";
import {
  composeHooks,
  emailHooks,
  mailer,
  type Mailer,
  type MailerArgs,
} from "./email";
import { createStore } from "./store";
import type { Store } from "./store/types";
import { tenancy, type Tenancy, type TenancyArgs } from "./tenancy";

let config: SaasConfig | undefined;

/**
 * What the component told the function it deployed, or one that links it.
 * Read once, the first time it's asked for.
 */
export function loadConfig(): SaasConfig {
  if (config) return config;
  const value = process.env[CONFIG_ENV];
  if (!value)
    throw new Error(
      `${CONFIG_ENV} isn't set. Link the Saas component to this function, or add the route with saas.route().`,
    );
  return (config = JSON.parse(value) as SaasConfig);
}

/**
 * What the handlers and middleware are given. Each is read from what the
 * component set up when it isn't given.
 */
export interface SetupArgs extends Partial<TenancyArgs> {
  /** Your own store, in place of the one the component set up. */
  store?: Store;
  /** In place of what's in `SAAS_CONFIG`. */
  config?: SaasConfig;
  /** A sender and templates of your own, for the emails. */
  email?: MailerArgs;
}

/**
 * The store and the rules on it, made the first time they're needed, so
 * that loading a file reads nothing from the environment. With `email` in
 * the config, the built-in emails are sent before your own hooks run.
 */
export function lazySetup(args: SetupArgs = {}) {
  let made:
    | { config: SaasConfig; store: Store; tenancy: Tenancy; mail?: Mailer }
    | undefined;
  return () => {
    if (made) return made;
    const config = args.config ?? loadConfig();
    const store = args.store ?? createStore(config.store);
    const mail = config.email && mailer(config.email, args.email);
    const hooks = mail
      ? composeHooks(
          emailHooks(mail, store, config.email!.messages),
          args.hooks,
        )
      : args.hooks;
    return (made = {
      config,
      store,
      mail,
      tenancy: tenancy({ ...args, hooks, store, config }),
    });
  };
}

/**
 * Send emails of your own, with the component's sender and templates. It
 * reads the config the first time it's used.
 *
 * ```ts
 * const mail = createMailer();
 * await mail.send({ to, ...mail.templates.welcome({ user, app: mail.app }) });
 * ```
 */
export function createMailer(
  args: MailerArgs & { config?: SaasConfig } = {},
): Mailer {
  let made: Mailer | undefined;
  const get = () => {
    if (made) return made;
    const email = (args.config ?? loadConfig()).email;
    if (!email)
      throw new Error(
        `The Saas component has no "email", so there's nothing to send emails from.`,
      );
    return (made = mailer(email, args));
  };
  return {
    get app() {
      return get().app;
    },
    get templates() {
      return get().templates;
    },
    send: (mail) => get().send(mail),
  };
}
