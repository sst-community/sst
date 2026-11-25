# sst dev's local console

`sst dev --console` starts a page on `127.0.0.1` that shows what `sst dev` does: another view of the events it publishes on its bus, next to the terminal UI, in any `--mode`. It's made of modules that are each turned on or off:

```sh
sst dev --console                    # every module
sst dev --console=logs,deploy        # only these, with =
SST_CONSOLE=logs,stats sst dev       # the same, from the environment
```

Without the flag or the variable nothing starts: no listener, no subscription to the bus, no sampling.

| Module | Shows |
|---|---|
| `logs` | What functions, tasks and Cloudflare workers print, grouped by invocation, with search, a level filter, a time range and follow. JSON lines (Powertools, pino) are shown as fields. |
| `invocations` | Each function invocation's input and output, asked for when it's opened. Turns on `logs`, which it adds to. |
| `deploy` | Each deploy: its resources as they change, its errors, what the program printed, its outputs. |
| `stats` | Per function: invocations, errors, p50/p95/p99 local duration, running, cold starts, builds. |
| `workers` | The CPU and memory of each local worker's processes, over time. |
| `host` | The machine's CPU, memory, swap and load, and `sst dev`'s own CPU, memory, heap, goroutines and bus subscribers. |

Durations, CPU and memory are local: `sst dev` runs the handlers on this machine, so they aren't Lambda's billed duration or memory.

## How it works

- **Its own listener on loopback.** Not a route on the dev server, which listens on every interface. The link `sst dev` prints carries a token that's new each run; opening it sets an `HttpOnly`, `SameSite=Strict` cookie for that port, and every request needs it. A request for another `Host` (DNS rebinding) or from another site (`Sec-Fetch-Site`) is refused, and only `GET` is served. The page has a strict Content-Security-Policy, and shows everything as text, never as markup.
- **One dispatcher.** The console reads one lossy bus subscription on one goroutine, which runs every module's handlers, ticks and snapshots, and what a route asks of a module (`Do`). A module's state needs no locks, and a page that connects gets a snapshot and then every message after it, none lost or sent twice.
- **It never slows the bus.** The subscription is lossy, so a console that falls behind loses events rather than stalling the publishers; what it lost is shown on the page. A page that falls behind is cut off and connects again for a fresh snapshot. Every store is bounded.
- **It costs nothing it doesn't need to.** A message is only marshalled when a page that shows its module is open. `workers` and `host` only sample while a page has their tab in view (the page says which with `GET /shown?page=<id>&module=<name>`), and off the dispatcher. `stats` sends its table only then too.
- **No build step.** The page is plain HTML, CSS and JavaScript, embedded with `go:embed`.

## Writing a module

A module is a Go package with a type that implements `console.Module`, and its part of the page in a `web` folder it embeds. Add it to `modules.All` in `modules/modules.go`, and it can be turned on with `--console=<name>`.

```go
package queues

//go:embed web
var web embed.FS

type Module struct{}

func (Module) Name() string  { return "queues" }   // --console=queues
func (Module) Title() string { return "Queues" }   // its tab, or "" to add to another's
func (Module) Web() fs.FS    { sub, _ := fs.Sub(web, "web"); return sub }

func (Module) Start(ctx context.Context, c *console.Console) error {
	depth := map[string]int{}
	c.On(&QueueEvent{}, func(evt any) {               // a bus event, as published (a made-up one)
		e := evt.(*QueueEvent)
		depth[e.Queue] = e.Depth
		c.Emit("queues", "depth", e)                  // to the pages that show it
	})
	c.Snapshot("queues", func() []console.Message { // what a page starts with
		return []console.Message{c.Message("queues", "all", depth)}
	})
	return nil
}
```

Everything a module registers runs on the dispatcher. Its routes (`c.Handle("GET /api/queues/{name}", ...)`) run on their own goroutines and read its state with `c.Do`. A module that samples checks `c.Watched(name)` in its `Every`, which is true while a page has its tab in view, then samples on a goroutine of its own and hands the result back with `c.Do`. The `Console`'s methods, `Watched` and `Emit` among them, run on the dispatcher: off it, call them in `c.Do`. A module that needs another implements `console.Requirer`.

Its `web/<name>.js` registers it with the page:

```js
SST.register({
  name: "queues",
  mount(panel) {},   // once, with its tab's element
  reset() {},        // when the page connects again, before the snapshot
  event(msg) {},     // each of its messages: {seq, time, module, type, data}
  flush() {},        // once a frame, after its messages: render here if SST.visible("queues")
  show() {},         // when its tab is opened
});
```

The page gives it `SST.h(tag, props, ...children)`, which makes elements and only ever sets text; `SST.fmt` (`time`, `duration`, `bytes`, `percent`, `number`); `SST.spark(values)` for a sparkline; `SST.api(path)`; `SST.copy(text)`; `SST.functionName(id)`; and `SST.hook(name, fn)` / `SST.call(name, ...args)` for adding to another module's view, as `invocations` adds payloads to `logs` with the `logs:detail` hook. A `web/<name>.css` is loaded too.

Test a module with `console.NewHarness`, which runs it without the bus or a listener: `Publish` an event, `Tick`, `Watch` for the snapshot, `Messages` for what a page got, and `Get` for its routes.

## Messages

`GET /events` is a stream of [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html), each one JSON:

```json
{"seq": 42, "time": 1732400000123, "module": "logs", "type": "line", "data": {"key": "c264e645-…", "t": 1732400000120, "text": "GET /cart/2"}}
```

`seq` orders them: the messages of a snapshot all have the `seq` of the last message before it, and come in the order to apply them. `time` is when the console handled the event, in Unix milliseconds. `?modules=logs,stats` picks some of the modules that are on. A stream starts with `core` `hello` (`{app, stage, version, functions, modules, page}`, where `page` is the stream's ID for `/shown`), then `core` `status`, then each module's snapshot, then `core` `ready`, and then everything after it. `core` sends `app` when the app or its functions change, and `status` (`{busDropped, busDroppedTotal, clients, resyncs, uptime}`) every second.

| Module | Type | Data |
|---|---|---|
| `logs` | `invocation` | `{key, kind, function, worker, request, title, start, end, status, cold, error, lines: [{t, text}], dropped}`. `kind` is `function`, `task` or `worker`; `status` is `running`, `ok` or `error`. |
| | `line` | `{key, t, text}` |
| | `end` | `{key, end, status, error: {type, message, trace}}` |
| | `build` | `{function, ok, errors, time}` |
| | `evicted` | `{keys}`: dropped to stay under the store's limits |
| `invocations` | | Sends nothing. `GET /api/invocations/{request}` answers `{request, function, worker, input, output, error}`, with `input` and `output` as `{text, size, truncated}` (the first 64 KB), or 404 once it's not kept. |
| `deploy` | `deploy` | `{id, command, start, end, status, resources, messages, errors, outputs, hints, dropped}` |
| | `resource` | `{deploy, resource: {urn, type, op, status, start, duration}}` |
| | `message` | `{deploy, message: {level, text, urn, time}}` |
| | `end` | `{deploy, end, status, errors: [{urn, message, help}], outputs, hints}`. `status` is `ok`, `error`, `skipped`, `cancelled`, `locked` or `interrupted`. |
| | `warning` | `{level, text, time}` |
| `stats` | `functions` | `{functions: [{id, invocations, errors, initErrors, running, cold, builds, buildErrors, p50, p95, p99, max, last}]}`, at most once a second while its tab is in view |
| `workers` | `worker` | `{id, function, pid, started, exited, samples: [{t, cpu, rss, processes}]}` |
| | `sample` | `{t, samples: [{id, cpu, rss, processes}]}` |
| | `exited` | `{id, t}` |
| | `removed` | `{id}` |
| `host` | `sample` | `{t, machine: {cpu, cores, memTotal, memUsed, swapTotal, swapUsed, load}, process: {cpu, rss, heap, sys, goroutines, gcPauseNs}, bus: [{label, lossy, queued, dropped}]}` |
