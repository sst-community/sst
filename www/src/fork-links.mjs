// Rehype plugin for the sst-community docs site, which is served under a base
// path (sst-community.github.io/sst). Root-relative links in Markdown and MDX
// get the base prefix. Links to pages the fork doesn't publish (SST's blog,
// about and legal pages) point at sst.dev instead. Links to the fork's files
// on main, like an example's, point at the branch these docs are built from.
const UPSTREAM_ONLY = ["/blog", "/about", "/legal"];
const ATTRIBUTES = ["href", "src", "link"];

export default function forkLinks({ base, bases = [base], fork, branch = "main" }) {
  const onBranch = (value) => {
    if (!fork || branch === "main") return value;
    for (const kind of ["tree", "blob", "edit"]) {
      const main = `${fork}/${kind}/main`;
      if (value === main || value.startsWith(main + "/")) return `${fork}/${kind}/${branch}` + value.slice(main.length);
    }
    return value;
  };
  const rewrite = (value) => {
    if (typeof value !== "string") return value;
    value = onBranch(value);
    if (!value.startsWith("/") || value.startsWith("//")) return value;
    // Already under a version's path, this one's or another's
    if (bases.some((b) => value === b || value.startsWith(b + "/"))) return value;
    if (UPSTREAM_ONLY.some((p) => value === p || value.startsWith(p + "/"))) return "https://sst.dev" + value;
    return base + value;
  };

  const walk = (node) => {
    if (node.type === "element" && node.properties) {
      for (const name of ATTRIBUTES) {
        if (name in node.properties) node.properties[name] = rewrite(node.properties[name]);
      }
    }
    // JSX in MDX, e.g. <a href="/docs/..."> or <LinkCard href="/docs/..." />
    if ((node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") && node.attributes) {
      for (const attr of node.attributes) {
        if (attr.type === "mdxJsxAttribute" && ATTRIBUTES.includes(attr.name)) attr.value = rewrite(attr.value);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };

  return walk;
}
