import { defineSuite } from './suite.mjs';

defineSuite({
	name: 'SvelteKit 3',
	fixtureDir: 'fixture-kit3',
	configFile: 'vite.config.ts',
	alias: '#lib',
	manifestFields: /app_dir: "_app",\s+app_path: "_app"/
});
