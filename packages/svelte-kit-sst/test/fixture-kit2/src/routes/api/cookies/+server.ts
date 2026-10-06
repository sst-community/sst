import type { RequestHandler } from './$types';

// Two Set-Cookie headers: API Gateway v2 wants them in `cookies`, not `headers`.
export const GET: RequestHandler = ({ cookies }) => {
	cookies.set('a', '1', { path: '/' });
	cookies.set('b', '2', { path: '/' });
	return Response.json({ ok: true });
};
