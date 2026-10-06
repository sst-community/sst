/// <reference path="./.sst/platform/config.d.ts" />

// End-to-end check of the adapter on a real AWS account. Nothing here is needed
// by `npm test`. From the repo root run `npm run build`, then in this folder:
//
//   AWS_PROFILE=<profile> npx sst deploy --stage adaptertest
//   curl <printed url>/ssr?name=Ada
//   AWS_PROFILE=<profile> npx sst remove --stage adaptertest
//
// No custom domain, so it is served from the CloudFront URL and costs cents.
export default $config({
	app(input) {
		return {
			name: 'svelte-kit-sst-fixture',
			removal: 'remove',
			home: 'aws'
		};
	},
	async run() {
		const site = new sst.aws.SvelteKit('Fixture', {
			environment: { FIXTURE_VALUE: 'from-real-lambda' }
		});
		return { url: site.url };
	}
});
