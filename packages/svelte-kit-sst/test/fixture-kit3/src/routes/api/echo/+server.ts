import type { RequestHandler } from './$types';

// Echoes the method, content type, body and client address back as JSON.
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const body = await request.text();
	return Response.json({
		method: request.method,
		contentType: request.headers.get('content-type'),
		body,
		ip: getClientAddress()
	});
};

export const GET: RequestHandler = async ({ url }) =>
	Response.json({ query: Object.fromEntries(url.searchParams) });
