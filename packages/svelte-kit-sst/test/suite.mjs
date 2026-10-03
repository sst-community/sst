// Builds the Kit 3 fixture with this adapter, bundles the generated Lambda
// handler with the same esbuild options SST uses, and calls it with fake
// API Gateway events. No AWS account or network needed.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'example.test';

function run(cmd, args, cwd, env = {}) {
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
	return { ...r, out: `${r.stdout}\n${r.stderr}` };
}

// Options mirror pkg/runtime/node/build.go in sst-community/sst.
async function bundle(entry, outfile) {
	await build({
		entryPoints: [entry],
		outfile,
		platform: 'node',
		format: 'esm',
		bundle: true,
		minify: true,
		keepNames: true,
		target: 'node22',
		mainFields: ['module', 'main'],
		banner: {
			js: [
				`import { createRequire as topLevelCreateRequire } from 'module';`,
				`const require = topLevelCreateRequire(import.meta.url);`,
				`import { fileURLToPath as topLevelFileUrlToPath, URL as topLevelURL } from "url"`,
				`const __filename = topLevelFileUrlToPath(import.meta.url)`,
				`const __dirname = topLevelFileUrlToPath(new topLevelURL(".", import.meta.url))`
			].join('\n')
		},
		logLevel: 'warning'
	});
}

/** API Gateway v2 (HTTP API) event */
function v2(rawPath, { method = 'GET', query = '', headers = {}, cookies, body, b64 = false } = {}) {
	return {
		version: '2.0',
		rawPath,
		rawQueryString: query,
		cookies,
		headers: { host: HOST, ...headers },
		requestContext: { http: { method, sourceIp: '203.0.113.9' } },
		body,
		isBase64Encoded: b64
	};
}

/**
 * @param {object} options
 * @param {string} options.name label for the report, e.g. "SvelteKit 3"
 * @param {string} options.fixtureDir folder name under test/
 * @param {string} options.configFile file in the fixture that imports the adapter
 * @param {string} options.alias import alias for src/lib: "#lib" (Kit 3) or "$lib" (Kit 2)
 * @param {RegExp} options.manifestFields matches the fields sst.aws.SvelteKit reads
 */
export function defineSuite({ name, fixtureDir, configFile, alias, manifestFields }) {
const fixture = path.join(root, 'test', fixtureDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-kit-sst-'));

let handler;
let prerenderedDir;
let output;

describe(name, () => {
before(async () => {
	assert.ok(fs.existsSync(path.join(root, 'dist', 'index.js')), 'run `npm run build` first');

	if (!fs.existsSync(path.join(fixture, 'node_modules'))) {
		const i = run('npm', ['install', '--no-audit', '--no-fund'], fixture);
		assert.equal(i.status, 0, i.out);
	}
	const b = run('npx', ['vite', 'build'], fixture);
	assert.equal(b.status, 0, b.out);

	output = path.join(fixture, '.svelte-kit', 'svelte-kit-sst');
	const bundled = path.join(tmp, 'index.mjs');
	await bundle(path.join(output, 'server', 'lambda-handler', 'index.js'), bundled);

	// SST copies the prerendered folder next to the bundle, and runs from there.
	prerenderedDir = path.join(tmp, 'prerendered');
	fs.cpSync(path.join(output, 'prerendered'), prerenderedDir, { recursive: true });
	process.chdir(tmp);
	process.env.FIXTURE_VALUE = 'from-lambda-env';
	({ handler } = await import(bundled));
});

describe('output layout (what sst.aws.SvelteKit relies on)', () => {
	it('writes the handler, client, prerendered and server folders', () => {
		for (const p of ['server/lambda-handler/index.js', 'client/_app', 'prerendered/index.html', 'server/server.js']) {
			assert.ok(fs.existsSync(path.join(output, p)), `missing ${p}`);
		}
	});

	it('does not import anything Kit 3 removed', () => {
		const src = fs.readFileSync(path.join(output, 'server/lambda-handler/index.js'), 'utf8');
		assert.doesNotMatch(src, /node\/polyfills/);
		assert.match(src, /from "\.\.\/server\.js"/);
	});

	it('writes manifest.js with the app dir and app path fields', () => {
		const m = fs.readFileSync(path.join(output, 'server/manifest.js'), 'utf8');
		assert.match(m, manifestFields);
	});
});

describe('requests', () => {
	it('serves a prerendered page from the prerendered folder', async () => {
		const r = await handler(v2('/'));
		assert.equal(r.statusCode, 200);
		assert.match(r.headers['content-type'], /text\/html/);
		assert.equal(r.body, fs.readFileSync(path.join(prerenderedDir, 'index.html'), 'utf8'));
	});

	it('tells CloudFront which prerendered file to fetch (Lambda@Edge)', async () => {
		const cf = { Records: [{ cf: { request: { method: 'GET', uri: '/', querystring: '', headers: { host: [{ key: 'host', value: HOST }] }, clientIp: '203.0.113.9' } } }] };
		const r = await handler(cf);
		assert.equal(r.uri, '/index.html');
	});

	it('renders a server route with the query string and cookies', async () => {
		const r = await handler(v2('/ssr', { query: 'name=Ada', cookies: ['visits=4'] }));
		assert.equal(r.statusCode, 200);
		assert.match(r.body, /Hello Ada/);
		assert.match(r.body, /visits: 5/);
		assert.ok(r.cookies.some((c) => c.startsWith('visits=5')), JSON.stringify(r.cookies));
	});

	it('sends several cookies in `cookies`, not in headers', async () => {
		const r = await handler(v2('/api/cookies'));
		assert.equal(r.statusCode, 200);
		assert.deepEqual(r.cookies.map((c) => c.split(';')[0]).sort(), ['a=1', 'b=2']);
		assert.equal(r.headers['set-cookie'], undefined);
	});

	it('passes a JSON POST body and the client address through', async () => {
		const r = await handler(v2('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }));
		assert.equal(r.statusCode, 200);
		assert.deepEqual(JSON.parse(r.body), { method: 'POST', contentType: 'application/json', body: '{"a":1}', ip: '203.0.113.9' });
	});

	it('decodes a base64 request body', async () => {
		const body = Buffer.from('héllo').toString('base64');
		const r = await handler(v2('/api/echo', { method: 'POST', headers: { 'content-type': 'text/plain', origin: `https://${HOST}` }, body, b64: true }));
		assert.equal(JSON.parse(r.body).body, 'héllo');
	});

	it('returns binary responses as base64 without corrupting the bytes', async () => {
		const r = await handler(v2('/api/binary'));
		assert.equal(r.isBase64Encoded, true);
		assert.deepEqual([...Buffer.from(r.body, 'base64')], [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
	});

	it('reads Kit 3 env vars (defineEnvVars) from process.env', async () => {
		const r = await handler(v2('/api/env'));
		assert.equal(r.statusCode, 200);
		assert.deepEqual(JSON.parse(r.body), { value: 'from-lambda-env' });
	});

	it('returns a redirect with its Location header', async () => {
		const r = await handler(v2('/go'));
		assert.equal(r.statusCode, 302);
		assert.equal(r.headers.location, '/ssr?name=redirected');
	});

	it('returns 500 when a route throws', async () => {
		const r = await handler(v2('/boom', { headers: { accept: 'application/json' } }));
		assert.equal(r.statusCode, 500);
	});

	it('returns 404 for an unknown route', async () => {
		const r = await handler(v2('/nope', { headers: { accept: 'text/html' } }));
		assert.equal(r.statusCode, 404);
		assert.match(r.headers['content-type'], /text\/html/);
	});

	it('accepts API Gateway v1 (REST API) events', async () => {
		const r = await handler({ httpMethod: 'GET', path: '/api/echo', queryStringParameters: { x: '1' }, multiValueQueryStringParameters: null, headers: { host: HOST }, multiValueHeaders: {}, requestContext: { identity: { sourceIp: '203.0.113.9' } }, body: null });
		assert.equal(r.statusCode, 200);
		assert.deepEqual(JSON.parse(r.body), { query: { x: '1' } });
	});
});

describe('form actions', () => {
	const form = (body, headers = {}) =>
		v2('/ssr', {
			method: 'POST',
			body,
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}`, accept: 'text/html', ...headers }
		});

	it('runs a form action from a urlencoded POST', async () => {
		const r = await handler(form('name=alice'));
		assert.equal(r.statusCode, 200);
		assert.match(r.body, /saved: alice/);
	});

	it('returns the fail() status and data', async () => {
		const r = await handler(form('name='));
		assert.equal(r.statusCode, 400);
		assert.match(r.body, /name required/);
	});

	it('follows a redirect() from an action', async () => {
		const r = await handler(form('name=go'));
		assert.equal(r.statusCode, 303);
		assert.equal(r.headers.location, '/ssr?name=redirected');
	});

	it('rejects a cross-origin form POST (CSRF) with 403', async () => {
		const r = await handler(form('name=alice', { origin: 'https://evil.test' }));
		assert.equal(r.statusCode, 403);
	});

	it('honours x-forwarded-host when checking the origin', async () => {
		const r = await handler(form('name=alice', { host: 'abc.lambda-url.us-east-1.on.aws', 'x-forwarded-host': HOST }));
		assert.equal(r.statusCode, 200);
	});
});

describe('adapter.supports', () => {
	it('fails the build with a clear message when a route uses `read`', () => {
		const copy = path.join(tmp, 'read-fixture');
		fs.cpSync(fixture, copy, { recursive: true, filter: (s) => !/[\\/](\.svelte-kit|node_modules)([\\/]|$)/.test(s) });
		fs.symlinkSync(path.join(fixture, 'node_modules'), path.join(copy, 'node_modules'));
		fs.writeFileSync(path.join(copy, configFile), fs.readFileSync(path.join(copy, configFile), 'utf8').replace('../../dist/index.js', path.join(root, 'dist', 'index.js')));
		fs.mkdirSync(path.join(copy, 'src/routes/uses-read'), { recursive: true });
		fs.writeFileSync(
			path.join(copy, 'src/routes/uses-read/+server.ts'),
			`import { read } from '$app/server';\nimport logo from '${alias}/assets/favicon.svg';\nexport const GET = () => read(logo);\n`
		);
		const b = run('npx', ['vite', 'build'], copy);
		assert.notEqual(b.status, 0, 'expected the build to fail');
		assert.match(b.out, /doesn't support `read`/);
	});
});
});
}
