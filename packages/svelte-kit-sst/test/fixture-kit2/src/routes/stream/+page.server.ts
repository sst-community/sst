export const load = () => ({
	now: 'instant-value',
	// Not awaited, so SvelteKit streams it after the page
	later: new Promise<string>((resolve) => setTimeout(() => resolve('streamed-value'), 300))
});
