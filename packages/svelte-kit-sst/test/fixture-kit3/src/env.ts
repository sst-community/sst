import { defineEnvVars } from '@sveltejs/kit/env';

// Kit 3 environment variables. The adapter has to pass `process.env` to
// `server.init({ env })` for these to resolve on Lambda.
export const variables = defineEnvVars({
	FIXTURE_VALUE: { schema: (input) => input ?? 'unset' }
});
