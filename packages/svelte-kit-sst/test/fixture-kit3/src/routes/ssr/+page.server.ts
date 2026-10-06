import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';

// Server-rendered on every request: reads the query string and a cookie,
// and sets a cookie back.
export const load: PageServerLoad = async ({ url, cookies }) => {
	const visits = Number(cookies.get('visits') ?? '0') + 1;
	cookies.set('visits', String(visits), { path: '/', httpOnly: true });
	return { name: url.searchParams.get('name') ?? 'nobody', visits };
};

export const actions: Actions = {
	// A form action: exercises urlencoded POST bodies through the Lambda mapper.
	default: async ({ request }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '');
		if (!name) return fail(400, { error: 'name required' });
		if (name === 'go') redirect(303, '/ssr?name=redirected');
		return { saved: name };
	}
};
