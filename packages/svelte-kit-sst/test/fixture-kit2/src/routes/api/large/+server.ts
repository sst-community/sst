import type { RequestHandler } from './$types';

// 3 MB sent as 3,072 chunks of 1 KB, so a client reading slowly makes the handler wait.
export const GET: RequestHandler = () => {
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent === 3072) return controller.close();
			controller.enqueue(new Uint8Array(1024).fill(sent % 251));
			sent++;
		}
	});
	return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
};
