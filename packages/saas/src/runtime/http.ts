import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CLAIMS } from "../config";

/** What API Gateway sends a function behind an HTTP API with a JWT authorizer. Only what's read here. */
export interface ApiEvent {
  routeKey: string;
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: {
    authorizer?: {
      jwt?: {
        claims: Record<string, string | number | boolean | string[]>;
        scopes?: string[] | null;
      };
    };
  };
}

/** What a function behind an HTTP API returns. */
export interface ApiResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * An error to answer with: its status, a code your client can match, and a
 * message. It's a Hono `HTTPException`, so a Hono app answers with its JSON
 * body without an error handler of its own.
 */
export class HttpError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
  ) {
    super(status, {
      message,
      res: new Response(JSON.stringify({ error: { code, message } }), {
        headers: { "content-type": "application/json" },
      }),
    });
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, code = "bad_request") =>
  new HttpError(400, code, message);
export const unauthorized = (message = "Sign in first.") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message: string, code = "forbidden") =>
  new HttpError(403, code, message);
export const notFound = (message: string, code = "not_found") =>
  new HttpError(404, code, message);
export const conflict = (message: string, code = "conflict") =>
  new HttpError(409, code, message);

export function json(statusCode: number, body?: unknown): ApiResult {
  if (body === undefined) return { statusCode };
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** The answer for an error. One that isn't an `HttpError` is logged, and answered with a 500. */
export function errorResult(error: unknown): ApiResult {
  if (error instanceof HttpError)
    return json(error.status, {
      error: { code: error.code, message: error.message },
    });
  console.error(error);
  return json(500, {
    error: { code: "internal", message: "Something went wrong." },
  });
}

export function isResult(value: unknown): value is ApiResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ApiResult).statusCode === "number"
  );
}

/** The request's JSON body, as an object. */
export function bodyOf(event: ApiEvent): Record<string, unknown> {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString()
    : event.body;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest("The body isn't valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw badRequest("The body has to be a JSON object.");
  return body as Record<string, unknown>;
}

/** Who's calling, and the tenant their token is for, from the token's claims. */
export interface Auth {
  userId: string;
  /** The tenant the token is for. */
  tenantId?: string;
  /** The user's role in it, when the token was issued. */
  role?: string;
  /** Whether the user was a platform admin when the token was issued. */
  platformAdmin: boolean;
  /** The token's scopes. */
  scopes: string[];
  /** Every claim in the token. */
  claims: Record<string, string | number | boolean | string[]>;
}

/**
 * Who's calling, from the claims of the token the API checked. These are as
 * they were when the token was issued; `authorize()` checks the store.
 */
export function auth(event: ApiEvent): Auth {
  const jwt = event.requestContext?.authorizer?.jwt;
  const claims = jwt?.claims;
  if (!claims?.sub) throw unauthorized();
  const text = (claim: string) => {
    const value = claims[claim];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const scope = text("scope");
  return {
    userId: String(claims.sub),
    tenantId: text(CLAIMS.tenant),
    role: text(CLAIMS.role),
    platformAdmin: String(claims[CLAIMS.platformAdmin]) === "true",
    scopes: jwt?.scopes ?? (scope ? scope.split(" ") : []),
    claims,
  };
}
