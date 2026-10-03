import type { RequestHandler } from './$types';

// Bytes that are not valid UTF-8, so a text round trip would corrupt them.
export const GET: RequestHandler = () =>
	new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]), {
		headers: { 'content-type': 'image/png' }
	});
