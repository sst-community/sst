import { CONFIG_ENV, type SaasConfig } from "../config";
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
}

/**
 * The store and the rules on it, made the first time they're needed, so
 * that loading a file reads nothing from the environment.
 */
export function lazySetup(args: SetupArgs = {}) {
  let made: { config: SaasConfig; store: Store; tenancy: Tenancy } | undefined;
  return () => {
    if (made) return made;
    const config = args.config ?? loadConfig();
    const store = args.store ?? createStore(config.store);
    return (made = {
      config,
      store,
      tenancy: tenancy({ ...args, store, config }),
    });
  };
}
