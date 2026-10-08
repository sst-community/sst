// Builds the Kit 3 fixture with this adapter, bundles the generated Lambda
// handler with the same esbuild options SST uses, and calls it with fake
// API Gateway events. No AWS account or network needed.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * @param {boolean} options.polyfills whether the server installs Kit 2's Node polyfills
 */
export function defineSuite({ name, fixtureDir, configFile, alias, manifestFields, polyfills }) {
const fixture = path.join(root, 'test', fixtureDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-kit-sst-'));

let handler;
let streamHandler;
let prerenderedDir;
let output;
let bundled;

describe(name, () => {
before(async () => {
	assert.ok(fs.existsSync(path.join(root, 'dist', 'index.js')), 'run `npm run build` first');

	if (!fs.existsSync(path.join(fixture, 'node_modules'))) {
		// `npm ci` installs exactly what the fixture's lockfile pins.
		const cmd = fs.existsSync(path.join(fixture, 'package-lock.json')) ? 'ci' : 'install';
		const i = run('npm', [cmd, '--no-audit', '--no-fund'], fixture);
		assert.equal(i.status, 0, i.out);
	}
	const b = run('npx', ['vite', 'build'], fixture);
	assert.equal(b.status, 0, b.out);

	output = path.join(fixture, '.svelte-kit', 'svelte-kit-sst');
	bundled = path.join(tmp, 'index.mjs');
	await bundle(path.join(output, 'server', 'lambda-handler', 'index.js'), bundled);

	// SST copies the prerendered folder next to the bundle, and runs from there.
	prerenderedDir = path.join(tmp, 'prerendered');
	fs.cpSync(path.join(output, 'prerendered'), prerenderedDir, { recursive: true });
	process.chdir(tmp);
	process.env.FIXTURE_VALUE = 'from-lambda-env';
	({ handler } = await import(bundled));

	// The Lambda runtime sets `awslambda`. Record what the handler streams.
	globalThis.awslambda = {
		streamifyResponse: (fn) => fn,
		HttpResponseStream: {
			from: (stream, metadata) => {
				stream.metadata = metadata;
				return stream;
			}
		}
	};
	const bundledStream = path.join(tmp, 'stream.mjs');
	await bundle(path.join(output, 'server', 'lambda-handler', 'stream.js'), bundledStream);
	({ handler: streamHandler } = await import(bundledStream));
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

	it(polyfills ? "installs Kit 2's polyfills in server.js" : 'does not import the removed polyfills module in server.js', () => {
		const src = fs.readFileSync(path.join(output, 'server/server.js'), 'utf8');
		if (polyfills) {
			assert.match(src, /import \{ installPolyfills \} from "@sveltejs\/kit\/node\/polyfills"/);
			assert.match(src, /installPolyfills\(\);[\s\S]*new Server\(manifest\)/);
		} else {
			assert.doesNotMatch(src, /node\/polyfills/);
		}
	});
});

describe('Node globals', () => {
	// Node 18 has no `crypto` or `File` global. Remove them, as on Node 18, and
	// check the bundled handler puts them back before SvelteKit starts.
	it(
		'sets crypto and File when the runtime lacks them',
		{ skip: !polyfills && 'SvelteKit 3 requires Node 22.17+, which has both globals' },
		() => {
			const code = [
				'delete globalThis.File;',
				'delete globalThis.crypto;',
				`await import(${JSON.stringify(pathToFileURL(bundled).href)});`,
				'console.log(JSON.stringify({ File: typeof globalThis.File, crypto: typeof globalThis.crypto?.getRandomValues }));'
			].join('\n');
			const r = run(process.execPath, ['--input-type=module', '-e', code], tmp);
			assert.equal(r.status, 0, r.out);
			const last = r.stdout.trim().split('\n').pop();
			assert.deepEqual(JSON.parse(last), { File: 'function', crypto: 'function' });
		}
	);
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

	it('takes the client address from CloudFront-Viewer-Address, not X-Forwarded-For', async () => {
		const echo = async (headers) => {
			const r = await handler(v2('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }));
			return JSON.parse(r.body).ip;
		};
		assert.equal(await echo({ 'x-forwarded-for': '203.0.113.66', 'cloudfront-viewer-address': '198.51.100.7:44321' }), '198.51.100.7');
		assert.equal(await echo({ 'cloudfront-viewer-address': '[2001:db8::7]:44321' }), '2001:db8::7');
		// CloudFront writes IPv6 addresses without brackets, with the port after the last colon.
		assert.equal(await echo({ 'cloudfront-viewer-address': '2001:db8::7:44321' }), '2001:db8::7');
		assert.equal(await echo({ 'cloudfront-viewer-address': '2001:db8:85a3:0:0:8a2e:370:7334:46532' }), '2001:db8:85a3:0:0:8a2e:370:7334');
		assert.equal(await echo({ 'x-forwarded-for': '203.0.113.66' }), '203.0.113.9');
		// A value that isn't an IP address with a port wasn't sent by CloudFront.
		assert.equal(await echo({ 'cloudfront-viewer-address': 'not-an-ip:1234' }), '203.0.113.9');
		assert.equal(await echo({ 'cloudfront-viewer-address': '198.51.100.7' }), '203.0.113.9');
		assert.equal(await echo({ 'cloudfront-viewer-address': ':44321' }), '203.0.113.9');
	});

	it('takes the client address from CloudFront-Viewer-Address in API Gateway v1 events', async () => {
		const echo = async (headers, multiValueHeaders = {}) => {
			const r = await handler({ httpMethod: 'POST', path: '/api/echo', queryStringParameters: null, multiValueQueryStringParameters: null, headers: { host: HOST, 'content-type': 'application/json', ...headers }, multiValueHeaders, requestContext: { identity: { sourceIp: '203.0.113.9' } }, body: '{}' });
			return JSON.parse(r.body).ip;
		};
		assert.equal(await echo({ 'x-forwarded-for': '203.0.113.66', 'cloudfront-viewer-address': '198.51.100.7:44321' }), '198.51.100.7');
		assert.equal(await echo({}), '203.0.113.9');
		// A repeated header is joined with a comma in v1 events, which is not an IP address.
		assert.equal(await echo({}, { 'cloudfront-viewer-address': ['198.51.100.7:44321', '203.0.113.66:55555'] }), '203.0.113.9');
	});

	it('takes the client address from CloudFront-Viewer-Address in Lambda@Edge events', async () => {
		const echo = async (extraHeaders) => {
			const headers = { host: [{ key: 'host', value: HOST }], 'content-type': [{ key: 'content-type', value: 'application/json' }] };
			for (const [key, value] of Object.entries(extraHeaders)) headers[key] = [{ key, value }];
			const r = await handler({ Records: [{ cf: { request: { method: 'POST', uri: '/api/echo', querystring: '', headers, body: { data: '{}', encoding: 'text' }, clientIp: '203.0.113.9' } } }] });
			return JSON.parse(r.body).ip;
		};
		assert.equal(await echo({ 'cloudfront-viewer-address': '198.51.100.7:44321' }), '198.51.100.7');
		// Without the header, `clientIp` is the viewer's address in Lambda@Edge.
		assert.equal(await echo({}), '203.0.113.9');
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

describe('streaming', () => {
	/** Calls the streaming handler and records each chunk with the time it was written. */
	async function stream(event, { slow = false, highWaterMark = 16384 } = {}) {
		const chunks = [];
		let maxQueued = 0;
		// Lambda sends the status and headers just before the first write, even an empty one.
		let wrote = false;
		const start = Date.now();
		const responseStream = new Writable({
			highWaterMark,
			write(chunk, _encoding, callback) {
				wrote = true;
				// An empty write sends no bytes; it only makes Lambda send the status and headers.
				if (chunk.length > 0) {
					chunks.push({ at: Date.now() - start, text: Buffer.from(chunk).toString('utf8'), bytes: Buffer.from(chunk) });
				}
				maxQueued = Math.max(maxQueued, responseStream.writableLength);
				if (slow) setImmediate(callback);
				else callback();
			}
		});
		const done = new Promise((resolve) => responseStream.on('finish', resolve));
		await streamHandler(event, responseStream, {});
		await done;
		return {
			...responseStream.metadata,
			chunks,
			maxQueued,
			wrote,
			body: chunks.map((c) => c.text).join(''),
			bytes: Buffer.concat(chunks.map((c) => c.bytes))
		};
	}

	it('writes adapter.json with streaming off by default', () => {
		const meta = JSON.parse(fs.readFileSync(path.join(output, 'adapter.json'), 'utf8'));
		assert.deepEqual(meta, { streaming: false });
	});

	it('sends the page before a promise from load resolves, then the rest', async () => {
		const r = await stream(v2('/stream', { headers: { accept: 'text/html' } }));
		assert.equal(r.statusCode, 200);
		assert.match(r.headers['content-type'], /text\/html/);
		assert.ok(r.chunks.length > 1, `expected several chunks, got ${r.chunks.length}`);
		assert.match(r.chunks[0].text, /instant-value/);
		assert.doesNotMatch(r.chunks[0].text, /streamed-value/);
		assert.match(r.body, /streamed-value/);
		const last = r.chunks.findLast((c) => c.text.includes('streamed-value'));
		assert.ok(last.at - r.chunks[0].at >= 200, `the promise's chunk came ${last.at - r.chunks[0].at}ms after the first`);
	});

	it('serves a prerendered page from the prerendered folder', async () => {
		const r = await stream(v2('/'));
		assert.equal(r.statusCode, 200);
		assert.equal(r.body, fs.readFileSync(path.join(prerenderedDir, 'index.html'), 'utf8'));
	});

	it('reads the request cookies and sends cookies in `cookies`, not in headers', async () => {
		const r = await stream(v2('/ssr', { query: 'name=Ada', cookies: ['visits=4'] }));
		assert.match(r.body, /Hello Ada/);
		assert.match(r.body, /visits: 5/);
		assert.ok(r.cookies.some((c) => c.startsWith('visits=5')), JSON.stringify(r.cookies));
		assert.equal(r.headers['set-cookie'], undefined);

		const c = await stream(v2('/api/cookies'));
		assert.deepEqual(c.cookies.map((c) => c.split(';')[0]).sort(), ['a=1', 'b=2']);
	});

	it('leaves `cookies` out of the response metadata when the response sets none', async () => {
		const r = await stream(v2('/api/binary'));
		assert.equal(r.statusCode, 200);
		assert.equal('cookies' in r, false);
	});

	it('passes a POST body and the client address through', async () => {
		const r = await stream(v2('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }));
		assert.deepEqual(JSON.parse(r.body), { method: 'POST', contentType: 'application/json', body: '{"a":1}', ip: '203.0.113.9' });
	});

	it('streams binary responses as raw bytes', async () => {
		const r = await stream(v2('/api/binary'));
		assert.deepEqual([...r.bytes], [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
	});

	it('takes the client address from CloudFront-Viewer-Address, not X-Forwarded-For', async () => {
		const echo = async (headers) => {
			const r = await stream(v2('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }));
			return JSON.parse(r.body).ip;
		};
		assert.equal(await echo({ 'x-forwarded-for': '203.0.113.66', 'cloudfront-viewer-address': '198.51.100.7:44321' }), '198.51.100.7');
		assert.equal(await echo({ 'cloudfront-viewer-address': '2001:db8::7:44321' }), '2001:db8::7');
		assert.equal(await echo({ 'x-forwarded-for': '203.0.113.66' }), '203.0.113.9');
	});

	it('sends the status and headers of a response with no body, and no body bytes', async () => {
		const r = await stream(v2('/api/empty'));
		assert.equal(r.statusCode, 204);
		assert.equal(r.headers['x-empty'], 'yes');
		assert.equal(r.wrote, true, 'nothing was written, so Lambda would not send the headers');
		assert.equal(r.bytes.length, 0);
	});

	it('sends the status and headers of a response whose body is an empty string', async () => {
		const r = await stream(v2('/api/empty200'));
		assert.equal(r.statusCode, 200);
		assert.equal(r.headers['x-empty'], 'yes');
		assert.match(r.headers['content-type'], /text\/plain/);
		assert.equal(r.wrote, true, 'nothing was written, so Lambda would not send the headers');
		assert.equal(r.bytes.length, 0);
	});

	it('waits for the stream to drain, so a large body is not queued whole', async () => {
		const r = await stream(v2('/api/large'), { slow: true, highWaterMark: 1024 });
		assert.equal(r.bytes.length, 3 * 1024 * 1024);
		assert.ok(r.maxQueued < 512 * 1024, `up to ${r.maxQueued} bytes were queued at once`);
	});

	it('returns a redirect with its Location header', async () => {
		const r = await stream(v2('/go'));
		assert.equal(r.statusCode, 302);
		assert.equal(r.headers.location, '/ssr?name=redirected');
	});

	it('returns 404 for an unknown route', async () => {
		const r = await stream(v2('/nope', { headers: { accept: 'text/html' } }));
		assert.equal(r.statusCode, 404);
	});
});

describe('adapter options', () => {
	it('writes adapter.json with streaming on for adapter({ streaming: true })', () => {
		const copy = path.join(tmp, 'streaming-fixture');
		fs.cpSync(fixture, copy, { recursive: true, filter: (s) => !/[\\/](\.svelte-kit|node_modules)([\\/]|$)/.test(s) });
		fs.symlinkSync(path.join(fixture, 'node_modules'), path.join(copy, 'node_modules'));
		const config = fs.readFileSync(path.join(copy, configFile), 'utf8')
			.replace('../../dist/index.js', path.join(root, 'dist', 'index.js'))
			.replace('adapter()', 'adapter({ streaming: true })');
		assert.match(config, /streaming: true/);
		fs.writeFileSync(path.join(copy, configFile), config);
		const b = run('npx', ['vite', 'build'], copy);
		assert.equal(b.status, 0, b.out);
		const meta = JSON.parse(fs.readFileSync(path.join(copy, '.svelte-kit', 'svelte-kit-sst', 'adapter.json'), 'utf8'));
		assert.deepEqual(meta, { streaming: true });
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
