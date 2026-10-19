// What the functions run: the built-in routes and triggers, and what your
// own routes use. Nothing here loads Pulumi.

export {
  ALL_SCOPE,
  CLAIMS,
  DEFAULT_MESSAGES,
  DEFAULT_ROLES,
  MESSAGES,
  PERMISSIONS,
  PLATFORM_ADMIN_SCOPE,
  ROUTES,
  scopeOf,
  type BuiltInMessage,
  type BuiltInPermission,
  type BuiltInRoute,
  type Roles,
  type EmailConfig,
  type SaasConfig,
  type StoreConfig,
} from "../config";
export {
  saasApp,
  authorized,
  type SaasAppOptions,
  type SaasBindings,
  type SaasEnv,
} from "./app";
export {
  createHandlers,
  type Claims,
  type ClaimsInput,
  type CognitoTriggerEvent,
  type HandlerOptions,
} from "./handlers";
export { route, type RouteOptions } from "./route";
export type { Requirement, SaasContext } from "./context";
export { createMailer, loadConfig, type SetupArgs } from "./env";
export {
  defaultTemplates,
  escape,
  sesSender,
  type App,
  type Mail,
  type Mailer,
  type MailerArgs,
  type Message,
  type Person,
  type Send,
  type Templates,
} from "./email";
export {
  auth,
  badRequest,
  conflict,
  forbidden,
  HttpError,
  json,
  notFound,
  unauthorized,
  type ApiEvent,
  type ApiResult,
  type Auth,
} from "./http";
export { allows, covers, permissionsOf, type Permissions } from "./roles";
export {
  tenancy,
  type Access,
  type Identity,
  type Member,
  type Tenancy,
  type TenancyArgs,
  type TenancyHooks,
} from "./tenancy";
export * from "./store";
