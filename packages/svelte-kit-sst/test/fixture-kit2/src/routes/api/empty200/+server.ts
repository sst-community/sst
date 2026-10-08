import type { RequestHandler } from './$types';

// A 200 with an empty string as its body: a body stream with no chunks, not null.
export const GET: RequestHandler = () => new Response('', { status: 200, headers: { 'content-type': 'text/plain', 'x-empty': 'yes' } });
