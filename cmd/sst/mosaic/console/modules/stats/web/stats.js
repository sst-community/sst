// The stats module's tab: a table of every function's invocations, errors and
// local durations.
"use strict";

(() => {
  const { h, fmt } = SST;
  const COLUMNS = [
    ["name", "Function", (f) => SST.functionName(f.id)],
    ["invocations", "Invocations", (f) => f.invocations, true],
    ["errors", "Errors", (f) => f.errors, true],
    ["rate", "Error rate", (f) => (f.invocations ? f.errors / f.invocations : 0), true],
    ["running", "Running", (f) => f.running, true],
    ["cold", "Cold", (f) => f.cold, true],
    ["builds", "Builds", (f) => f.builds, true],
    ["p50", "p50", (f) => f.p50, true],
    ["p95", "p95", (f) => f.p95, true],
    ["p99", "p99", (f) => f.p99, true],
    ["max", "Max", (f) => f.max, true],
    ["last", "Last", (f) => f.last || 0, true],
  ];
  let rows = [];
  let sort = { key: "invocations", desc: true };
  let table, body, dirty = true;

  function cell(key, f) {
    switch (key) {
      case "name": return h("td", { class: "fname" }, h("a", { href: "#logs", text: SST.functionName(f.id), title: "Show its logs",
        onclick: (e) => { e.preventDefault(); SST.call("logs:filter", f.id); } }));
      case "rate": {
        const r = f.invocations ? f.errors / f.invocations : 0;
        return h("td", { class: "num" + (r > 0 ? " bad" : ""), text: f.invocations ? (r * 100).toFixed(r && r < 0.1 ? 1 : 0) + "%" : "" });
      }
      case "errors": return h("td", {
        class: "num" + (f.errors || f.initErrors ? " bad" : ""),
        text: fmt.number(f.errors) + (f.initErrors ? ` (+${fmt.number(f.initErrors)} at start)` : ""),
        title: f.initErrors ? "Invocations that failed, and times a worker failed as it started" : null,
      });
      case "builds": return h("td", { class: "num", text: fmt.number(f.builds) + (f.buildErrors ? ` (${f.buildErrors} failed)` : "") });
      case "p50": case "p95": case "p99": case "max": return h("td", { class: "num", text: f.invocations ? fmt.duration(f[key]) : "" });
      case "last": return h("td", { class: "num note", text: f.last ? fmt.clock(f.last) : "" });
      default: return h("td", { class: "num", text: fmt.number(f[key]) });
    }
  }

  function render() {
    if (!dirty || !SST.visible("stats")) return;
    dirty = false;
    const col = COLUMNS.find((c) => c[0] === sort.key) || COLUMNS[1];
    const sorted = [...rows].sort((a, b) => {
      const x = col[2](a), y = col[2](b);
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      // by name among the same value, so rows hold still between updates
      return (sort.desc ? -c : c) || a.id.localeCompare(b.id);
    });
    table.tHead.replaceChildren(h("tr", {}, COLUMNS.map(([key, label, , num]) => h("th", {
      class: "sortable" + (num ? " num" : "") + (sort.key === key ? " sorted" : ""),
      text: label + (sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""),
      onclick: () => { sort = { key, desc: sort.key === key ? !sort.desc : key !== "name" }; dirty = true; render(); },
    }))));
    body.replaceChildren(...sorted.map((f) => h("tr", {}, COLUMNS.map(([key]) => cell(key, f)))));
    if (!rows.length) body.appendChild(h("tr", {}, h("td", { colspan: COLUMNS.length, class: "empty-state", text: "No invocations yet." })));
  }

  SST.register({
    name: "stats",
    mount(panel) {
      panel.classList.add("stats");
      table = h("table", { class: "grid" }, h("thead"), (body = h("tbody")));
      panel.append(
        h("div", { class: "toolbar" }, h("span", { class: "note", text: "Durations are local: sst dev runs your handlers on this machine, so they aren't Lambda's billed duration. Percentiles are of each function's last 1,000 invocations." })),
        h("div", { class: "wrap" }, table),
      );
    },
    reset() { rows = []; dirty = true; },
    event(msg) {
      if (msg.type === "functions") rows = msg.data.functions || [];
      dirty = true;
    },
    flush: render,
    show() { dirty = true; render(); },
  });
})();
