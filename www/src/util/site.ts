// Absolute URL of a page on this docs site, for places that leave the site,
// like llms.txt and the raw-markdown pages. `path` has no leading slash.
export function siteUrl(path: string): string {
  const site = import.meta.env.SITE.replace(/\/$/, "");
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${site}${base}/${path}`;
}
