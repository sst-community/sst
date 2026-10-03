import type { RequestHandler } from './$types';
import { FIXTURE_VALUE } from '$app/env/private';

export const GET: RequestHandler = () => Response.json({ value: FIXTURE_VALUE });
