import { contextOf, type Requirement, type SaasContext } from "./context";
import { lazySetup, type SetupArgs } from "./env";
import {
  errorResult,
  isResult,
  json,
  type ApiEvent,
  type ApiResult,
} from "./http";

export interface RouteOptions extends Requirement, SetupArgs {}

/**
 * A function for one route, without Hono. It reads the caller from their
 * token and checks what the route asks for against the store. Return a
 * value to answer with it as JSON, nothing for a 204, or a result of your
 * own. Throw an `HttpError` to answer with it.
 *
 * ```ts
 * export const handler = route(async (event, { auth, store }) => {
 *   return { tenant: auth.tenantId };
 * }, { permission: "projects:read" });
 * ```
 */
export function route(
  fn: (event: ApiEvent, context: SaasContext) => unknown,
  options: RouteOptions = {},
) {
  const setup = lazySetup(options);
  return async (event: ApiEvent): Promise<ApiResult> => {
    try {
      const result = await fn(event, await contextOf(event, setup, options));
      if (isResult(result)) return result;
      return result === undefined ? json(204) : json(200, result);
    } catch (error) {
      return errorResult(error);
    }
  };
}
