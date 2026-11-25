// The deploy module's tab: each deploy sst dev ran, its resources as they
// changed, its errors, what the program printed, and its outputs.
"use strict";

(() => {
  const { h, fmt } = SST;
  const STATUS = {
    running: ["running", "Deploying"], ok: ["ok", "Complete"], error: ["error", "Failed"],
    skipped: ["", "No changes"], cancelled: ["warn", "Cancelled"], locked: ["error", "Locked"],
    interrupted: ["warn", "Interrupted"],
  };
  const OPS = {
    create: "Create", update: "Update", delete: "Delete", replace: "Replace", "create-replacement": "Create",
    "delete-replaced": "Delete", import: "Import", refresh: "Refresh", "discard": "Discard", read: "Read",
  };

  let deploys = [];
  let byId = new Map();
  let warnings = [];
  let selected = "";
  let panel, side, main, banner;
  let dirty = true;

  // urn is a resource's name and type, as the terminal shows them
  function urn(u) {
    if (!u) return { name: "", type: "" };
    const parts = u.split("::");
    let name = parts[parts.length - 1] || u;
    const qualified = parts[parts.length - 2] || "";
    let type = qualified.split("$").pop();
    const m = /^([^:]+):([^:]+):(.+)$/.exec(type);
    if (m) type = `${m[1]}:${m[2].split("/")[0]}:${m[3]}`;
    const dot = name.indexOf(".");
    if (dot >= 0) {
      type = name.slice(dot + 1).replace(/\./g, ":");
      name = name.slice(0, dot);
    }
    return { name, type };
  }

  function badge(status) {
    const [cls, label] = STATUS[status] || ["", status];
    return h("span", { class: "badge " + cls, text: label });
  }

  function renderSide() {
    side.replaceChildren(...[...deploys].reverse().map((d) => {
      const changed = d.resources.filter((r) => r.op !== "same").length;
      return h("div", { class: "dep" + (d.id === current().id ? " sel" : ""), onclick: () => { selected = d.id; dirty = true; render(); } },
        h("div", { class: "row" }, badge(d.status), h("span", { class: "grow" }), h("span", { class: "note mono", text: fmt.clock(d.start) })),
        h("div", { class: "note" }, `${d.command} · ${changed} ${changed === 1 ? "change" : "changes"}`, d.end ? ` · ${fmt.duration(d.end - d.start)}` : ""),
      );
    }));
  }

  function current() {
    return byId.get(selected) || deploys[deploys.length - 1];
  }

  function renderResource(r) {
    const { name, type } = urn(r.urn);
    const cls = r.status === "failed" ? "error" : r.status === "running" ? "running" : r.op === "delete" || r.op === "delete-replaced" ? "" : "ok";
    const label = r.status === "failed" ? "Failed" : r.status === "running" ? (OPS[r.op] || r.op) + "…" : OPS[r.op] || r.op;
    return h("tr", {},
      h("td", {}, h("span", { class: "badge " + cls, text: label })),
      h("td", { class: "rname", text: name, title: r.urn }),
      h("td", { class: "note mono", text: type }),
      h("td", { class: "num note", text: r.duration ? fmt.duration(r.duration) : "" }),
    );
  }

  function renderDeploy(d) {
    const out = [];
    out.push(h("div", { class: "dhead" },
      h("h2", { text: d.command[0].toUpperCase() + d.command.slice(1) }),
      badge(d.status),
      h("span", { class: "note", text: fmt.time(d.start) }),
      d.end ? h("span", { class: "note", text: "took " + fmt.duration(d.end - d.start) }) : null,
    ));
    if (d.errors.length) {
      out.push(h("div", { class: "derrs" }, d.errors.map((e) => h("div", { class: "derr" },
        e.urn ? h("div", { class: "dname", text: urn(e.urn).name + " " + urn(e.urn).type }) : null,
        h("pre", { text: e.message }),
        (e.help || []).length ? h("pre", { class: "help", text: e.help.join("\n") }) : null,
      ))));
    }
    const hints = Object.entries(d.hints || {}).sort();
    const outputs = Object.entries(d.outputs || {}).sort();
    if (hints.length || outputs.length) {
      const link = (v) => /^https?:\/\//.test(v) ? h("a", { href: v, target: "_blank", rel: "noreferrer noopener", text: v }) : h("span", { text: v });
      out.push(h("div", { class: "card" }, h("h3", { text: "Outputs" }),
        h("table", { class: "kvs" }, h("tbody", {},
          hints.map(([k, v]) => h("tr", {}, h("td", { class: "note", text: k.split("::").pop() }), h("td", { class: "mono" }, link(v)))),
          outputs.map(([k, v]) => h("tr", {}, h("td", { class: "note", text: k }), h("td", { class: "mono" }, link(v)))),
        ))));
    }
    if (d.resources.length) {
      const done = d.resources.filter((r) => r.status === "done").length;
      out.push(h("div", { class: "card" },
        h("h3", {}, "Resources ", h("span", { class: "note", text: `${done} of ${d.resources.length} done` })),
        h("table", { class: "grid" }, h("tbody", {}, d.resources.map(renderResource)))));
    } else if (d.status === "running") {
      out.push(h("div", { class: "empty-state", text: "Building and looking for changes…" }));
    } else if (d.status === "ok" || d.status === "skipped") {
      out.push(h("div", { class: "empty-state", text: "No changes." }));
    }
    if (d.messages.length) {
      out.push(h("div", { class: "card" }, h("h3", { text: "Messages" }),
        h("div", { class: "msgs" }, d.messages.map((m) => h("div", { class: "dmsg lv-" + m.level },
          h("span", { class: "note mono", text: fmt.clock(m.time) }),
          m.urn ? h("span", { class: "note", text: urn(m.urn).name }) : null,
          h("span", { class: "text", text: m.text }))))));
    }
    if (d.dropped) out.push(h("div", { class: "note", text: `${d.dropped} more resources and messages weren't kept.` }));
    return out;
  }

  function render() {
    if (!dirty || !SST.visible("deploy")) return;
    dirty = false;
    banner.replaceChildren(...warnings.slice(-5).map((w) => h("div", { class: "warning", text: w.text })));
    banner.hidden = !warnings.length;
    renderSide();
    const d = current();
    main.replaceChildren(...(d ? renderDeploy(d) : [h("div", { class: "empty-state", text: "Waiting for the first deploy…" })]));
  }

  function find(id) { return byId.get(id); }

  SST.register({
    name: "deploy",
    mount(p) {
      panel = p;
      panel.classList.add("deploy");
      banner = h("div", { class: "banner", hidden: true });
      side = h("aside", { class: "deps" });
      main = h("div", { class: "dmain" });
      panel.append(banner, h("div", { class: "split" }, side, main));
    },
    reset() { deploys = []; byId = new Map(); warnings = []; dirty = true; },
    event(msg) {
      const d = msg.data;
      dirty = true;
      switch (msg.type) {
        case "deploy": {
          const dep = Object.assign({ resources: [], messages: [], errors: [] }, d);
          dep.byUrn = new Map(dep.resources.map((r) => [r.urn, r]));
          if (!byId.has(dep.id)) deploys.push(dep);
          else deploys[deploys.indexOf(byId.get(dep.id))] = dep;
          byId.set(dep.id, dep);
          if (deploys.length > 20) byId.delete(deploys.shift().id);
          // one that was following the latest keeps following it
          if (selected === deploys[deploys.length - 2]?.id) selected = "";
          break;
        }
        case "resource": {
          const dep = find(d.deploy);
          if (!dep) break;
          const r = dep.byUrn.get(d.resource.urn);
          if (r) Object.assign(r, d.resource);
          else { dep.resources.push(d.resource); dep.byUrn.set(d.resource.urn, d.resource); }
          break;
        }
        case "message": {
          const dep = find(d.deploy);
          if (dep) dep.messages.push(d.message);
          break;
        }
        case "end": {
          const dep = find(d.deploy);
          if (!dep) break;
          Object.assign(dep, { end: d.end, status: d.status, errors: d.errors || [], outputs: d.outputs, hints: d.hints });
          break;
        }
        case "warning":
          warnings.push(d);
          if (warnings.length > 100) warnings.shift();
          break;
      }
    },
    flush: render,
    show() { dirty = true; render(); },
  });
})();
