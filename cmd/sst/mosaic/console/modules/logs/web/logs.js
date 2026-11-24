// The logs module's tab: invocations of functions, tasks and workers with what
// they printed. It renders what changed once a frame, and keeps at most
// MAX_SHOWN invocations, and MAX_LINES of each, in the page.
"use strict";

(() => {
  const { h, fmt } = SST;
  const MAX_SHOWN = 300;
  const MAX_LINES = 200;
  const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
  const LEVEL_NAMES = { warning: "warn", err: "error", critical: "fatal", notice: "info", verbose: "debug" };
  const PINO = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
  const KIND_ICON = { function: "λ", task: "⧉", worker: "☁" };
  const RANGES = [["", "All time"], ["300000", "Last 5 min"], ["900000", "Last 15 min"], ["3600000", "Last hour"]];
  // the fields a JSON log line has that aren't shown as its fields
  const QUIET = new Set(["message", "msg", "level", "levelname", "severity", "time", "timestamp", "@timestamp", "v", "pid", "hostname"]);

  let invs = new Map();
  let items = [];
  let functions = new Map();
  const filter = { fn: "", q: "", level: "", range: "", since: 0 };

  let panel, list, side, jump, countEl;
  let shown = new Map();
  let full = true;
  let added = [];
  let follow = true;
  let pendingScroll = false;

  function level(name) {
    if (name === undefined || name === null) return null;
    if (typeof name === "number") return PINO[name] || null;
    const n = String(name).toLowerCase();
    if (n in LEVELS) return n;
    return LEVEL_NAMES[n] || null;
  }

  // parse reads a line's level, and its fields when it's JSON, as from
  // Powertools or pino. It's done once, when the line arrives.
  function parse(text) {
    const line = { text, msg: text, level: null, json: null, lower: text.toLowerCase() };
    let rest = text;
    const tabs = text.split("\t");
    // Lambda's own format: time, request ID, level, message
    if (tabs.length >= 4 && /^\d{4}-\d\d-\d\dT/.test(tabs[0]) && level(tabs[2])) {
      line.level = level(tabs[2]);
      rest = tabs.slice(3).join("\t");
      line.msg = rest;
    } else {
      const m = /^\s*\[?(trace|debug|info|warn|warning|error|fatal)\]?[\s:]+/i.exec(text);
      if (m) {
        line.level = level(m[1]);
        line.msg = text.slice(m[0].length);
        rest = line.msg;
      }
    }
    const trimmed = rest.trim();
    if (trimmed.length > 1 && trimmed[0] === "{" && trimmed[trimmed.length - 1] === "}") {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          line.json = obj;
          line.level = level(obj.level ?? obj.levelname ?? obj.severity) || line.level;
          const msg = obj.message ?? obj.msg;
          line.msg = typeof msg === "string" ? msg : "";
        }
      } catch {}
    }
    return line;
  }

  function fnInfo(id, kind) {
    let f = functions.get(id);
    if (!f) {
      f = { id, kind: kind || "function", count: 0, errors: 0 };
      functions.set(id, f);
    }
    if (kind) f.kind = kind;
    return f;
  }

  function add(inv) {
    const old = invs.get(inv.key);
    if (old) remove(old.key);
    inv.lines = (inv.lines || []).map((l) => Object.assign(parse(l.text), { t: l.t }));
    inv.item = "invocation";
    invs.set(inv.key, inv);
    items.push(inv);
    const f = fnInfo(inv.function, inv.kind);
    f.count++;
    if (inv.status === "error") f.errors++;
    return inv;
  }

  function remove(key) {
    const inv = invs.get(key);
    if (!inv) return;
    invs.delete(key);
    inv.removed = true;
    const f = functions.get(inv.function);
    if (f) {
      f.count--;
      if (inv.status === "error") f.errors--;
    }
    const el = shown.get(key);
    if (el) {
      el.remove();
      shown.delete(key);
    }
  }

  function compact() {
    if (items.length > invs.size * 2 + 100) items = items.filter((i) => i.item !== "invocation" || !i.removed);
  }

  // what passes the filters

  function matchesLine(line) {
    if (!filter.level) return true;
    return (LEVELS[line.level || "info"] ?? 2) >= LEVELS[filter.level];
  }

  function matchesSearch(inv) {
    const q = filter.q;
    if (!q) return true;
    if (inv.item === "build") {
      return (SST.functionName(inv.function) + " " + (inv.errors || []).join(" ")).toLowerCase().includes(q);
    }
    const head = [SST.functionName(inv.function), inv.function, inv.request, inv.title, inv.worker, inv.error && inv.error.message]
      .filter(Boolean).join(" ").toLowerCase();
    if (head.includes(q)) return true;
    return inv.lines.some((l) => l.lower.includes(q));
  }

  function matches(item) {
    if (filter.fn && item.function !== filter.fn) return false;
    const t = item.item === "build" ? item.time : item.start;
    if (filter.since && t < filter.since) return false;
    if (filter.range && t < Date.now() - Number(filter.range)) return false;
    if (item.item === "build") return !filter.level || !item.ok || LEVELS[filter.level] <= LEVELS.info;
    if (filter.level && LEVELS[filter.level] >= LEVELS.error && item.status === "error") return matchesSearch(item);
    if (filter.level && !item.lines.some(matchesLine) && !(item.status === "error")) return false;
    return matchesSearch(item);
  }

  // rendering

  function renderLine(inv, line) {
    const offset = line.t && inv.start ? "+" + fmt.duration(Math.max(0, line.t - inv.start)) : "";
    const lv = line.level;
    const el = h("div", { class: "line" + (lv ? " lv-" + lv : "") + (filter.q && line.lower.includes(filter.q) ? " hit" : "") },
      h("span", { class: "off", text: offset, title: fmt.time(line.t) }),
      lv ? h("span", { class: "lvl", text: lv.toUpperCase() }) : null,
      h("span", { class: "msg" }, line.json ? jsonLine(line) : line.msg),
    );
    if (line.json) {
      el.classList.add("json");
      el.addEventListener("click", (e) => {
        if (e.target.closest(".pretty") || getSelection().toString()) return;
        const open = el.querySelector(".pretty");
        if (open) open.remove();
        else el.appendChild(h("pre", { class: "pretty", text: JSON.stringify(line.json, null, 2) }));
      });
    }
    return el;
  }

  function jsonLine(line) {
    const out = [];
    if (line.msg) out.push(h("span", { class: "jmsg", text: line.msg }));
    for (const [k, v] of Object.entries(line.json)) {
      if (QUIET.has(k)) continue;
      let s = typeof v === "string" ? v : JSON.stringify(v);
      if (s && s.length > 160) s = s.slice(0, 160) + "…";
      out.push(h("span", { class: "kv" }, h("span", { class: "k", text: k }), h("span", { class: "v", text: s })));
    }
    return out;
  }

  function duration(inv) {
    if (!inv.end || !inv.start || inv.kind === "worker") return "";
    return fmt.duration(inv.end - inv.start);
  }

  function renderHead(inv) {
    const status = inv.status === "running" ? "running" : inv.status === "error" ? "error" : "ok";
    const label = inv.status === "running" ? "Running" : inv.status === "error" ? "Error" : "Done";
    const parts = [
      h("span", { class: "when mono", text: fmt.time(inv.start) }),
      h("span", { class: "badge " + status, text: label }),
      h("span", { class: "kind", text: KIND_ICON[inv.kind] || "", title: inv.kind }),
      h("span", { class: "name", text: SST.functionName(inv.function) }),
      inv.title ? h("span", { class: "title", text: inv.title }) : null,
      inv.cold ? h("span", { class: "badge warn", text: "Cold", title: "The first invocation of this worker since it started or its function was built again" }) : null,
      h("span", { class: "dur mono", text: duration(inv) }),
      h("span", { class: "grow" }),
    ];
    if (inv.worker && inv.kind !== "worker") {
      parts.push(h("span", { class: "worker mono", text: "w:" + inv.worker.slice(-6), title: "Worker " + inv.worker }));
    }
    if (inv.request) {
      const id = h("span", { class: "req mono copy", text: inv.request, title: "Copy the request ID" });
      id.addEventListener("click", (e) => { e.stopPropagation(); SST.copy(inv.request, id); });
      parts.push(id);
    }
    if (inv.kind === "function" && inv.request && SST.has("logs:detail")) {
      parts.push(h("button", { class: "detail-toggle", text: "Payload", onclick: (e) => { e.stopPropagation(); toggleDetail(inv); } }));
    }
    return h("div", { class: "head" }, parts);
  }

  function renderError(inv) {
    const err = inv.error;
    if (!err) return null;
    return h("div", { class: "err" },
      h("div", { class: "emsg" }, err.type ? h("b", { text: err.type + ": " }) : null, err.message || ""),
      (err.trace || []).filter((t) => !t.includes("Error:")).map((t) => h("div", { class: "trace mono", text: "↳ " + t.trim() })),
    );
  }

  function renderInv(inv) {
    const el = h("div", { class: "inv st-" + inv.status, "data-key": inv.key });
    el.appendChild(renderHead(inv));
    const body = h("div", { class: "body" });
    let n = 0;
    for (const line of inv.lines) {
      if (!matchesLine(line)) continue;
      if (n++ >= MAX_LINES) break;
      body.appendChild(renderLine(inv, line));
    }
    const more = inv.lines.filter(matchesLine).length - MAX_LINES;
    if (more > 0) body.appendChild(moreButton(inv, more));
    if (inv.dropped) body.appendChild(h("div", { class: "dropped", text: `${fmt.number(inv.dropped)} more lines weren't kept` }));
    el.appendChild(body);
    const err = renderError(inv);
    if (err) el.appendChild(err);
    inv.body = body;
    inv.rendered = Math.min(n, MAX_LINES);
    return el;
  }

  function moreButton(inv, more) {
    return h("button", {
      class: "more", text: `Show ${fmt.number(more)} more lines`,
      onclick: (e) => {
        const btn = e.currentTarget;
        const rest = inv.lines.filter(matchesLine).slice(MAX_LINES);
        const frag = document.createDocumentFragment();
        for (const line of rest) frag.appendChild(renderLine(inv, line));
        btn.replaceWith(frag);
        inv.rendered = Infinity;
      },
    });
  }

  function renderBuild(b) {
    return h("div", { class: "build " + (b.ok ? "ok" : "error") },
      h("div", { class: "head" },
        h("span", { class: "when mono", text: fmt.time(b.time) }),
        h("span", { class: "badge " + (b.ok ? "ok" : "error"), text: b.ok ? "Built" : "Build error" }),
        h("span", { class: "name", text: SST.functionName(b.function) }),
      ),
      b.ok ? null : h("pre", { class: "berr", text: (b.errors || []).join("\n").trim() }),
    );
  }

  function toggleDetail(inv) {
    const el = shown.get(inv.key);
    if (!el) return;
    let box = el.querySelector(".detail");
    if (box) { box.remove(); inv.open = false; return; }
    box = h("div", { class: "detail" });
    el.insertBefore(box, el.querySelector(".body"));
    inv.open = true;
    SST.call("logs:detail", box, inv);
  }

  function renderAll() {
    full = false;
    added = [];
    shown = new Map();
    const matched = [];
    for (let i = items.length - 1; i >= 0 && matched.length < MAX_SHOWN; i--) {
      const it = items[i];
      if (it.removed) continue;
      if (matches(it)) matched.push(it);
    }
    matched.reverse();
    const frag = document.createDocumentFragment();
    for (const it of matched) {
      const el = it.item === "build" ? renderBuild(it) : renderInv(it);
      shown.set(it.key, el);
      frag.appendChild(el);
      if (it.open) {
        const box = h("div", { class: "detail" });
        el.insertBefore(box, el.querySelector(".body"));
        SST.call("logs:detail", box, it);
      }
    }
    list.replaceChildren(frag);
    if (!matched.length) list.appendChild(emptyState());
    pendingScroll = follow;
  }

  function emptyState() {
    if (items.length) return h("div", { class: "empty-state", text: "Nothing matches the filters." });
    return h("div", { class: "empty-state" }, h("div", { text: "Waiting for invocations…" }),
      h("div", { class: "note", text: "Invoke a function, and its logs show here." }));
  }

  function trim() {
    if (shown.size <= MAX_SHOWN) return;
    for (const [key, el] of shown) {
      if (shown.size <= MAX_SHOWN) break;
      el.remove();
      shown.delete(key);
    }
  }

  function renderSide() {
    const rows = [...functions.values()];
    for (const id of Object.keys(SST.state.functions)) if (!functions.has(id)) rows.push({ id, kind: "function", count: 0, errors: 0 });
    rows.sort((a, b) => (b.count > 0) - (a.count > 0) || SST.functionName(a.id).localeCompare(SST.functionName(b.id)));
    const total = [...functions.values()].reduce((n, f) => n + Math.max(0, f.count), 0);
    const row = (id, label, count, errors, kind) => h("div", {
      class: "fn" + (filter.fn === id ? " sel" : "") + (count ? "" : " idle"), title: id || "Everything",
      onclick: () => { filter.fn = filter.fn === id ? "" : id; full = true; renderSide(); schedule(); },
    },
      h("span", { class: "kind", text: kind ? KIND_ICON[kind] || "" : "" }),
      h("span", { class: "label", text: label }),
      errors > 0 ? h("span", { class: "errs", text: fmt.number(errors) }) : null,
      h("span", { class: "count", text: fmt.number(count) }),
    );
    side.replaceChildren(
      row("", "All", total, 0, ""),
      ...rows.map((f) => row(f.id, SST.functionName(f.id), Math.max(0, f.count), Math.max(0, f.errors), f.kind)),
    );
  }

  let sideTimer = 0;
  function sideSoon() {
    if (sideTimer) return;
    sideTimer = setTimeout(() => { sideTimer = 0; renderSide(); }, 500);
  }

  function schedule() {
    // the core flushes once a frame; a filter change renders now
    if (full) { renderAll(); scroll(); }
  }

  function scroll() {
    if (pendingScroll && follow) list.scrollTop = list.scrollHeight;
    pendingScroll = false;
    jump.hidden = follow;
  }

  function applyNew() {
    if (!added.length) return;
    let appended = false;
    for (const it of added) {
      if (it.removed || shown.has(it.key) || !matches(it)) continue;
      const placeholder = list.querySelector(".empty-state");
      if (placeholder) placeholder.remove();
      const el = it.item === "build" ? renderBuild(it) : renderInv(it);
      shown.set(it.key, el);
      list.appendChild(el);
      appended = true;
    }
    added = [];
    trim();
    if (appended) pendingScroll = true;
  }

  // event handlers

  function onLine(d) {
    const inv = invs.get(d.key);
    if (!inv) return;
    const line = Object.assign(parse(d.text), { t: d.t });
    inv.lines.push(line);
    const el = shown.get(inv.key);
    if (el) {
      if (filter.q && !matchesSearch(inv)) return;
      if (matchesLine(line) && inv.rendered < MAX_LINES) {
        inv.body.appendChild(renderLine(inv, line));
        inv.rendered++;
        pendingScroll = true;
      } else if (inv.rendered === MAX_LINES && matchesLine(line)) {
        // the rest is behind "show more", which counts it when it's opened
        inv.rendered++;
        inv.body.appendChild(moreButton(inv, inv.lines.filter(matchesLine).length - MAX_LINES));
      }
    } else if (!el && inv.start && (filter.q || filter.level)) {
      // a line can make an invocation match
      added.push(inv);
    }
  }

  function onEnd(d) {
    const inv = invs.get(d.key);
    if (!inv) return;
    inv.end = d.end;
    inv.status = d.status;
    inv.error = d.error;
    if (d.status === "error") {
      const f = fnInfo(inv.function);
      f.errors++;
    }
    const el = shown.get(inv.key);
    if (el) {
      el.className = "inv st-" + inv.status;
      el.replaceChild(renderHead(inv), el.firstChild);
      const err = renderError(inv);
      if (err) el.appendChild(err);
      pendingScroll = true;
    } else if (filter.level || filter.q) {
      added.push(inv);
    }
    sideSoon();
  }

  SST.register({
    name: "logs",
    mount(p) {
      panel = p;
      panel.classList.add("logs");
      const search = h("input", { type: "search", placeholder: "Search logs, functions, request IDs", spellcheck: "false" });
      let t = 0;
      search.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => { filter.q = search.value.trim().toLowerCase(); full = true; schedule(); }, 120);
      });
      const lvl = h("select", { title: "Show lines at this level or above" },
        h("option", { value: "", text: "All levels" }),
        ["debug", "info", "warn", "error"].map((l) => h("option", { value: l, text: l[0].toUpperCase() + l.slice(1) + "+" })));
      lvl.addEventListener("change", () => { filter.level = lvl.value; full = true; schedule(); });
      const range = h("select", { title: "Time range" }, RANGES.map(([v, label]) => h("option", { value: v, text: label })));
      range.addEventListener("change", () => { filter.range = range.value; full = true; schedule(); });
      const followBtn = h("button", { class: "on", text: "Follow", title: "Keep the newest in view" });
      followBtn.addEventListener("click", () => {
        follow = !follow;
        followBtn.classList.toggle("on", follow);
        if (follow) { pendingScroll = true; scroll(); }
      });
      const clear = h("button", { text: "Clear", title: "Hide what's here now. Nothing in sst dev is cleared." });
      clear.addEventListener("click", () => { filter.since = Date.now(); full = true; schedule(); });
      countEl = h("span", { class: "note" });
      jump = h("button", { class: "jump", text: "↓ Latest", hidden: true, onclick: () => { follow = true; followBtn.classList.add("on"); pendingScroll = true; scroll(); } });
      side = h("aside", { class: "fns" });
      list = h("div", { class: "list" });
      list.addEventListener("scroll", () => {
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
        if (atBottom !== follow) {
          follow = atBottom;
          followBtn.classList.toggle("on", follow);
          jump.hidden = follow;
        }
      }, { passive: true });
      panel.append(
        h("div", { class: "toolbar" }, search, lvl, range, h("span", { class: "grow" }), countEl, clear, followBtn),
        h("div", { class: "split" }, side, h("div", { class: "main" }, list, jump)),
      );
      setInterval(() => { if (filter.range && SST.visible("logs")) { full = true; schedule(); } }, 30000);
      SST.hook("logs:filter", (fn) => {
        filter.fn = fn;
        full = true;
        renderSide();
        SST.open("logs");
        schedule();
      });
    },
    reset() {
      invs = new Map();
      items = [];
      functions = new Map();
      full = true;
    },
    event(msg) {
      const d = msg.data;
      switch (msg.type) {
        case "invocation": {
          const inv = add(d);
          added.push(inv);
          sideSoon();
          break;
        }
        case "line": onLine(d); break;
        case "end": onEnd(d); break;
        case "build": {
          const b = Object.assign({}, d, { item: "build", key: "b" + msg.seq + ":" + d.function + ":" + d.time });
          items.push(b);
          fnInfo(d.function);
          added.push(b);
          break;
        }
        case "evicted":
          for (const key of d.keys || []) remove(key);
          compact();
          sideSoon();
          break;
      }
    },
    flush() {
      if (!SST.visible("logs")) return;
      if (full) renderAll();
      else applyNew();
      scroll();
      countEl.textContent = `${fmt.number(invs.size)} invocations kept`;
    },
    show() {
      full = true;
      renderSide();
      renderAll();
      scroll();
    },
  });
})();
