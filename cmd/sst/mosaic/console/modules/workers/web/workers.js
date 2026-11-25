// The workers module's tab: the CPU and memory of each local worker's
// processes, over time.
"use strict";

(() => {
  const { h, fmt, spark } = SST;
  let workers = new Map();
  let body, dirty = true;

  function render() {
    if (!dirty || !SST.visible("workers")) return;
    dirty = false;
    const list = [...workers.values()].sort((a, b) => (!!a.exited - !!b.exited) || last(b).cpu - last(a).cpu || b.started - a.started);
    if (!list.length) {
      body.replaceChildren(h("tr", {}, h("td", { colspan: 8, class: "empty-state", text: "No workers are running. Invoke a function to start one." })));
      return;
    }
    body.replaceChildren(...list.map((w) => {
      const s = last(w);
      const cpu = w.samples.map((x) => x.cpu);
      const rss = w.samples.map((x) => x.rss);
      return h("tr", { class: w.exited ? "exited" : "" },
        h("td", { class: "fname" }, h("div", { text: SST.functionName(w.function) }), h("div", { class: "note mono", text: w.id })),
        h("td", { class: "num mono", text: String(w.pid) }),
        h("td", { class: "num", text: w.exited ? "" : String(s.processes || "") }),
        h("td", { class: "num", text: w.exited ? "Exited" : w.samples.length > 1 ? fmt.percent(s.cpu) : "…" }),
        h("td", {}, spark(cpu, { max: Math.max(100, ...cpu) })),
        h("td", { class: "num", text: w.exited ? "" : fmt.bytes(s.rss) }),
        h("td", {}, spark(rss, { class: "info" })),
        h("td", { class: "num note", text: fmt.clock(w.started) }),
      );
    }));
  }

  function last(w) {
    return w.samples[w.samples.length - 1] || { cpu: 0, rss: 0, processes: 0 };
  }

  SST.register({
    name: "workers",
    mount(panel) {
      panel.classList.add("workers");
      const table = h("table", { class: "grid" },
        h("thead", {}, h("tr", {},
          h("th", { text: "Worker" }), h("th", { class: "num", text: "PID" }), h("th", { class: "num", text: "Processes" }),
          h("th", { class: "num", text: "CPU" }), h("th", { text: "CPU, 5 min" }), h("th", { class: "num", text: "Memory" }),
          h("th", { text: "Memory, 5 min" }), h("th", { class: "num", text: "Started" }))),
        (body = h("tbody")));
      panel.append(
        h("div", { class: "toolbar" }, h("span", { class: "note", text: "Each worker's process and what it started, sampled every 2 seconds while this tab is open. CPU is a percent of one core." })),
        table,
      );
    },
    reset() { workers = new Map(); dirty = true; },
    event(msg) {
      const d = msg.data;
      switch (msg.type) {
        case "worker": workers.set(d.id, d); break;
        case "sample":
          for (const s of d.samples) {
            const w = workers.get(s.id);
            if (!w) continue;
            w.samples.push(s);
            if (w.samples.length > 150) w.samples.shift();
          }
          break;
        case "exited": { const w = workers.get(d.id); if (w) w.exited = d.t; break; }
        case "removed": workers.delete(d.id); break;
      }
      dirty = true;
    },
    flush: render,
    show() { dirty = true; render(); },
  });
})();
