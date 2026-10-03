import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

export const GET: RequestHandler = () => Response.json({ value: env.FIXTURE_VALUE });
