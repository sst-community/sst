import { defineSuite } from './suite.mjs';

defineSuite({
	name: 'SvelteKit 2',
	fixtureDir: 'fixture-kit2',
	configFile: 'svelte.config.js',
	alias: '$lib',
	manifestFields: /appDir: "_app",\s+appPath: "_app"/,
	polyfills: true
});
