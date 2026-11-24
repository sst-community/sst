// The host module's tab: the machine's CPU, memory, swap and load, and sst
// dev's own, with what its bus subscribers lost.
"use strict";

(() => {
  const { h, fmt, spark } = SST;
  let samples = [];
  let grid, bus, dirty = true;

  function tile(label, value, sub, values, opts) {
    return h("div", { class: "tile" },
      h("div", { class: "tlabel", text: label }),
      h("div", { class: "tvalue", text: value }),
      h("div", { class: "note", text: sub || " " }),
      spark(values, Object.assign({ width: 240, height: 40 }, opts)),
    );
  }

  function render() {
    if (!dirty || !SST.visible("host")) return;
    dirty = false;
    const s = samples[samples.length - 1];
    if (!s) {
      grid.replaceChildren(h("div", { class: "empty-state", text: "Sampling…" }));
      bus.replaceChildren();
      return;
    }
    const m = s.machine, p = s.process;
    const series = (f) => samples.map(f);
    const load = m.load ? m.load.map((x) => x.toFixed(2)).join("  ") : "n/a";
    grid.replaceChildren(
      h("h3", { text: "This machine" }),
      h("div", { class: "tiles" },
        tile("CPU", fmt.percent(m.cpu), `${m.cores} cores`, series((x) => x.machine.cpu), { max: 100 }),
        tile("Memory", fmt.bytes(m.memUsed), `of ${fmt.bytes(m.memTotal)}`, series((x) => x.machine.memUsed), { max: m.memTotal, class: "info" }),
        tile("Swap", fmt.bytes(m.swapUsed), m.swapTotal ? `of ${fmt.bytes(m.swapTotal)}` : "none", series((x) => x.machine.swapUsed), { max: m.swapTotal || 1, class: "info" }),
        tile("Load", load, "1, 5 and 15 min", series((x) => (x.machine.load ? x.machine.load[0] : 0)), { max: Math.max(m.cores, ...series((x) => (x.machine.load ? x.machine.load[0] : 0))) }),
      ),
      h("h3", { text: "sst dev" }),
      h("div", { class: "tiles" },
        tile("CPU", fmt.percent(p.cpu), "of one core", series((x) => x.process.cpu), { max: 100 }),
        tile("Memory", fmt.bytes(p.rss), "resident", series((x) => x.process.rss), { class: "info" }),
        tile("Go heap", fmt.bytes(p.heap), `${fmt.bytes(p.sys)} from the OS`, series((x) => x.process.heap), { class: "info" }),
        tile("Goroutines", fmt.number(p.goroutines), "", series((x) => x.process.goroutines)),
      ),
    );
    const subs = [...(s.bus || [])].sort((a, b) => b.dropped - a.dropped || b.queued - a.queued);
    bus.replaceChildren(
      h("h3", {}, "Bus subscribers ", h("span", { class: "note", text: "what each one has waiting, and lost since sst dev started" })),
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, h("th", { text: "Subscriber" }), h("th", { text: "Kind" }), h("th", { class: "num", text: "Queued" }), h("th", { class: "num", text: "Dropped" }))),
        h("tbody", {}, subs.map((b) => h("tr", {},
          h("td", { class: "mono sub", text: b.label, title: b.label }),
          h("td", { class: "note", text: b.lossy ? "Firehose (lossy)" : "Typed" }),
          h("td", { class: "num", text: fmt.number(b.queued) }),
          h("td", { class: "num" + (b.dropped ? " bad" : ""), text: fmt.number(b.dropped) }),
        )))),
    );
  }

  SST.register({
    name: "host",
    mount(panel) {
      panel.classList.add("host");
      grid = h("div");
      bus = h("div", { class: "bus" });
      panel.append(
        h("div", { class: "toolbar" }, h("span", { class: "note", text: "Sampled every 2 seconds while this tab is open." })),
        h("div", { class: "hwrap" }, grid, bus),
      );
    },
    reset() { samples = []; dirty = true; },
    event(msg) {
      if (msg.type !== "sample") return;
      samples.push(msg.data);
      if (samples.length > 150) samples.shift();
      dirty = true;
    },
    flush: render,
    show() { dirty = true; render(); },
  });
})();
