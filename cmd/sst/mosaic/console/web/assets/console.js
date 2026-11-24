// sst dev's console: the page's core. It connects to /events, hands each
// module its messages once a frame, and switches tabs. A module registers
// with SST.register; see README.md.
"use strict";

const SST = (() => {
  const modules = new Map();
  const hooks = new Map();
  const state = { app: "", stage: "", version: "", functions: {}, status: {}, ready: false };
  let queue = [];
  let scheduled = false;
  let current = "";
  let page = 0;

  // tell the console which tab is in view, so a module that samples, like
  // the host's, does it only then
  function report() {
    if (!page) return;
    const module = document.hidden ? "" : current;
    fetch(`/shown?page=${page}&module=${encodeURIComponent(module)}`, { credentials: "same-origin" }).catch(() => {});
  }

  // h makes an element. Text is always set as text, never parsed as markup,
  // as what's shown comes from logs and payloads.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k === "href") el.setAttribute("href", safeHref(v));
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) append(el, child);
      else if (child instanceof Node) el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    }
  }

  // only links to web pages and the page's own routes
  function safeHref(href) {
    const s = String(href);
    if (s.startsWith("#") || s.startsWith("/")) return s;
    try {
      const u = new URL(s);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {}
    return "#";
  }

  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const fmt = {
    time(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    },
    clock(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },
    duration(ms) {
      if (ms === undefined || ms === null || isNaN(ms)) return "";
      if (ms === 0) return "0ms";
      if (ms < 1) return `${ms.toFixed(2)}ms`;
      if (ms < 1000) return `${Math.round(ms)}ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
      const m = Math.floor(ms / 60000);
      return `${m}m${pad(Math.round((ms % 60000) / 1000))}s`;
    },
    bytes(n) {
      if (!n) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
    },
    percent(n) {
      return `${(n || 0).toFixed(n < 10 ? 1 : 0)}%`;
    },
    number(n) {
      return (n || 0).toLocaleString();
    },
  };

  // spark draws values as a line, scaled to max (or their own), as SVG.
  function spark(values, opts = {}) {
    const w = opts.width || 120, hgt = opts.height || 28;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "spark" + (opts.class ? " " + opts.class : ""));
    svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("width", w);
    svg.setAttribute("height", hgt);
    if (values.length < 2) return svg;
    const max = opts.max || Math.max(...values) || 1;
    const step = w / (values.length - 1);
    let d = "";
    values.forEach((v, i) => {
      const y = hgt - 1 - Math.min(v / max, 1) * (hgt - 2);
      d += (i ? "L" : "M") + (i * step).toFixed(1) + " " + y.toFixed(1);
    });
    const area = document.createElementNS(ns, "path");
    area.setAttribute("d", `${d}L${w} ${hgt}L0 ${hgt}Z`);
    area.setAttribute("class", "area");
    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "line");
    svg.append(area, line);
    return svg;
  }

  async function api(path) {
    const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return res.json();
  }

  async function copy(text, el) {
    try {
      await navigator.clipboard.writeText(text);
      if (el) {
        el.classList.add("copied");
        setTimeout(() => el.classList.remove("copied"), 900);
      }
    } catch {}
  }

  // A module is {name, mount(panel), reset(), event(msg), flush(), show()}:
  // mount once with its panel (none for a module without a tab), reset when
  // the page connects again, event for each of its messages, flush once a
  // frame after its messages, show when its tab is opened. Only name is
  // needed.
  function register(def) {
    if (!def || !def.name) throw new Error("SST.register needs a name");
    modules.set(def.name, { def, panel: document.getElementById("panel-" + def.name), dirty: false });
  }

  // hook lets a module add to another's view: the other calls
  // SST.call(name, ...args), and gets what every hook returned.
  function hook(name, fn) {
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(fn);
  }
  function call(name, ...args) {
    return (hooks.get(name) || []).map((fn) => fn(...args));
  }
  function has(name) {
    return hooks.has(name);
  }

  function functionName(id) {
    return state.functions[id] || id;
  }

  function visible(name) {
    return current === name && !document.hidden;
  }

  function show(name) {
    const tabs = document.querySelectorAll("#tabs .tab");
    const names = [...tabs].map((t) => t.dataset.module);
    if (!names.includes(name)) name = names[0] || "none";
    current = name;
    for (const t of tabs) t.classList.toggle("active", t.dataset.module === name);
    for (const p of document.querySelectorAll("#panels .panel")) p.hidden = p.id !== "panel-" + name;
    const m = modules.get(name);
    if (m && m.def.show) m.def.show();
    report();
  }

  function open(name, then) {
    if (location.hash !== "#" + name) location.hash = name;
    else show(name);
    if (then) then();
  }

  function setStatus(kind, text, title) {
    const dot = document.getElementById("dot");
    dot.className = "dot " + kind;
    const t = document.getElementById("status-text");
    t.textContent = text;
    document.getElementById("status").title = title || "";
  }

  function core(msg) {
    const d = msg.data || {};
    switch (msg.type) {
      case "hello":
        state.ready = false;
        page = d.page || 0;
        report();
        for (const m of modules.values()) if (m.def.reset) m.def.reset();
      // fall through
      case "app":
        state.app = d.app || state.app;
        state.stage = d.stage || state.stage;
        state.version = d.version || state.version;
        state.functions = d.functions || {};
        if (state.app) {
          const where = document.getElementById("where");
          where.replaceChildren(state.app, h("span", { class: "dim", text: " / " }), state.stage);
          document.title = `${state.app} · ${state.stage} · sst dev console`;
        }
        for (const m of modules.values()) m.dirty = true;
        break;
      case "ready":
        state.ready = true;
        break;
      case "status":
        state.status = d;
        const unsent = Object.keys(d.unsent || {});
        if (unsent.length > 0) {
          setStatus("error", `Live · ${unsent.join(", ")} failing`,
            `Some of these modules' messages couldn't be sent: ${unsent.map((m) => `${m} ${fmt.number(d.unsent[m])}`).join(", ")}. sst dev's log has why.`);
        } else if (d.busDropped > 0) {
          setStatus("warn", `Live · ${fmt.number(d.busDropped)} dropped`,
            "The console fell behind sst dev's events and lost these. sst dev itself didn't slow down.");
        } else {
          setStatus("ok", "Live", `${d.clients} page(s) open`);
        }
        break;
    }
  }

  function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    for (const msg of batch) {
      if (msg.module === "core") { core(msg); continue; }
      const m = modules.get(msg.module);
      if (!m || !m.def.event) continue;
      m.def.event(msg);
      m.dirty = true;
    }
    for (const m of modules.values()) {
      if (m.dirty && m.def.flush) {
        m.dirty = false;
        m.def.flush();
      }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // a hidden tab gets no frames, so it's flushed on a timer instead
    if (document.hidden) setTimeout(flush, 250);
    else requestAnimationFrame(flush);
  }

  function connect() {
    const es = new EventSource("/events");
    es.onopen = () => setStatus("ok", "Live");
    es.onmessage = (e) => {
      queue.push(JSON.parse(e.data));
      schedule();
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus("off", "Disconnected", "sst dev stopped, or this link is from another run. Open the link it printed.");
      } else {
        setStatus("off", "Reconnecting");
      }
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    for (const m of modules.values()) if (m.def.mount) m.def.mount(m.panel);
    addEventListener("hashchange", () => show(location.hash.slice(1)));
    document.addEventListener("visibilitychange", () => {
      report();
      if (!document.hidden) {
        for (const m of modules.values()) m.dirty = true;
        schedule();
      }
    });
    show(location.hash.slice(1));
    connect();
  });

  return { register, h, fmt, spark, api, copy, hook, call, has, functionName, visible, open, state };
})();
