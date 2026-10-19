// What the functions run: the built-in routes and triggers, and what your
// own routes use. Nothing here loads Pulumi.

export {
  CLAIMS,
  DEFAULT_MESSAGES,
  DEFAULT_ROLES,
  MESSAGES,
  PERMISSIONS,
  PLATFORM_ADMIN_SCOPE,
  ROUTES,
  TENANT_HEADER,
  type BuiltInMessage,
  type BuiltInPermission,
  type BuiltInRoute,
  type Roles,
  type EmailConfig,
  type SaasConfig,
  type StoreConfig,
} from "../config.js";
export {
  saasApp,
  authorized,
  type SaasAppOptions,
  type SaasBindings,
  type SaasEnv,
} from "./app.js";
export {
  createHandlers,
  type Claims,
  type ClaimsInput,
  type CognitoTriggerEvent,
  type HandlerOptions,
} from "./handlers.js";
export { route, type RouteOptions } from "./route.js";
export type { Requirement, SaasContext } from "./context.js";
export { createMailer, loadConfig, type SetupArgs } from "./env.js";
export {
  defaultLayout,
  defaultTemplates,
  escape,
  sesSender,
  type App,
  type Body,
  type BoundTemplates,
  type Layout,
  type Mail,
  type Mailer,
  type MailerArgs,
  type Message,
  type NotifyInput,
  type NotifyResult,
  type Person,
  type Recipients,
  type Send,
  type TemplateContext,
  type Templates,
} from "./email.js";
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
} from "./http.js";
export { allows, covers, permissionsOf, type Permissions } from "./roles.js";
export {
  tenancy,
  type Access,
  type Identity,
  type Member,
  type Tenancy,
  type TenancyArgs,
  type TenancyHooks,
} from "./tenancy.js";
export * from "./store/index.js";
