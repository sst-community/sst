// The invocations module adds an invocation's input and output to the logs
// tab, asked for when it's opened, so the stream never carries payloads.
"use strict";

(() => {
  const { h, fmt } = SST;

  function pretty(text) {
    const t = text.trim();
    if (t[0] === "{" || t[0] === "[") {
      try { return JSON.stringify(JSON.parse(t), null, 2); } catch {}
    }
    return text;
  }

  function body(label, b, why) {
    if (!b) return h("div", { class: "pl none" }, h("span", { class: "pl-label", text: label }), h("span", { class: "note", text: why || "None yet" }));
    const text = pretty(b.text);
    const copyBtn = h("button", { text: "Copy", onclick: (e) => SST.copy(b.text, e.currentTarget) });
    return h("details", { class: "pl" },
      h("summary", {},
        h("span", { class: "pl-label", text: label }),
        h("span", { class: "note", text: fmt.bytes(b.size) + (b.truncated ? ` · first ${fmt.bytes(b.text.length)} shown` : "") }),
        h("span", { class: "grow" }),
        copyBtn,
      ),
      h("pre", { class: "pl-text", text }),
    );
  }

  SST.hook("logs:detail", async (box, inv) => {
    box.replaceChildren(h("div", { class: "pl-wait note", text: "Loading…" }));
    const p = await SST.api("/api/invocations/" + encodeURIComponent(inv.request));
    if (!p) {
      box.replaceChildren(h("div", { class: "pl-wait note", text: "This invocation's payloads are no longer kept." }));
      return;
    }
    box.replaceChildren(body("Input", p.input), body("Output", p.output, p.error ? "None: it failed, with the error below" : ""));
  });

  SST.register({ name: "invocations" });
})();
