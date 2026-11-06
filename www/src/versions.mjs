// The docs site has one version for each major version of SST. Each is built
// from its own branch and published under its own path, and docs.yml builds
// them all into one site. The header's switcher lists them, in this order.
export const versions = [
  { id: "4", label: "SST 4", base: "/sst", branch: "main" },
  {
    id: "5",
    label: "SST 5",
    base: "/sst/v5",
    branch: "v5",
    // Its pages say so in a banner, and ask search engines to leave them out
    prerelease: true,
  },
];

// The version these docs are. It's the one line that differs between the
// branches.
export const current = versions.find((version) => version.id === "5");

// The version a reader is sent to from a pre-release
export const latest = versions.find((version) => !version.prerelease);
