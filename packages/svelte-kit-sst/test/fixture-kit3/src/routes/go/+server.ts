import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';

export const GET: RequestHandler = () => redirect(302, '/ssr?name=redirected');
