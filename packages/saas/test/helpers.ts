import { DEFAULT_ROLES, type SaasConfig } from "../src/config.js";

/** What the component would tell its functions, with any of it changed. */
export const config = (patch: Partial<SaasConfig> = {}): SaasConfig => ({
  store: { type: "custom" },
  roles: DEFAULT_ROLES,
  ownerRole: "owner",
  defaultRole: "member",
  personal: true,
  selfServe: true,
  path: "",
  disabled: [],
  ...patch,
});
