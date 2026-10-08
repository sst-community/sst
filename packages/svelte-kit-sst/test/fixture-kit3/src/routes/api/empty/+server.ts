import type { RequestHandler } from './$types';

// A response with no body, like a 204.
export const GET: RequestHandler = () => new Response(null, { status: 204, headers: { 'x-empty': 'yes' } });
