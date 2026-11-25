package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/cmd/sst/eventflow"
	"github.com/sst/sst/v3/cmd/sst/mosaic/ui"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// How often the live view asks the router again
const eventflowRefresh = 2 * time.Second

var eventflowListFlags = []cli.Flag{
	{
		Name: "function",
		Type: "string",
		Description: cli.Description{
			Short: "Only the runs of this function",
			Long:  "Only the runs of the function with this ID.",
		},
	},
	{
		Name: "status",
		Type: "string",
		Description: cli.Description{
			Short: "Only the runs with this status",
			Long:  "Only the runs with this status: `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT` or `STOPPED`. Case doesn't matter.",
		},
	},
	{
		Name: "since",
		Type: "string",
		Description: cli.Description{
			Short: "Only the runs started since then, like 1h",
			Long:  "Only the runs started since then: a duration back from now, like `30m`, `1h`, `2d` or `1w`, or a time, like `2026-11-24T10:00:00Z`, `2026-11-24T10:00` or `2026-11-24`, in UTC.",
		},
	},
	{
		Name: "limit",
		Type: "string",
		Description: cli.Description{
			Short: "At most this many runs",
			Long:  "At most this many runs.",
		},
	},
}

var eventflowRunArg = cli.Argument{
	Name:     "runId",
	Required: true,
	Description: cli.Description{
		Short: "The ID of the run",
		Long:  "The ID of the run, as `sst eventflow runs` lists it.",
	},
}

var CmdEventFlow = &cli.Command{
	Name: "eventflow",
	Description: cli.Description{
		Short: "See and manage an EventFlow's runs",
		Long: strings.Join([]string{
			"See and manage the runs of an `EventFlow` component in your app.",
			"",
			"```bash frame=\"none\"",
			"sst eventflow",
			"```",
			"",
			"With no subcommand, this shows a live view of the EventFlow that refreshes every 2 seconds until you press Ctrl-C: its queue, dead letters, functions, the concurrency limits in use and who holds them, the runs waiting for an event, and the latest runs, with the failed ones in red.",
			"",
			"Print one snapshot and exit, for a script or a CI log, with `--once`.",
			"",
			"```bash frame=\"none\"",
			"sst eventflow --once",
			"```",
			"",
			"If your app has more than one `EventFlow`, pass the name of the one you want, as you named the component. The subcommands take it as `--name`.",
			"",
			"```bash frame=\"none\"",
			"sst eventflow Jobs",
			"sst eventflow runs --name Jobs",
			"```",
			"",
			"It uses your own AWS credentials, like `sst shell`, and the stage's last deploy to find the EventFlow. It calls the EventFlow's admin API, which its router serves.",
			"",
			"Every command takes `--json`, to print the API's result as it is.",
			"",
			"```bash frame=\"none\"",
			"sst eventflow runs --status FAILED --json",
			"```",
			"",
			":::tip",
			"Deployed a fix for a failed run? `sst eventflow retry <runId>` runs it again on the latest deploy, and the steps that succeeded return their saved results instead of running again.",
			":::",
		}, "\n"),
	},
	Args: []cli.Argument{
		{
			Name: "name",
			Description: cli.Description{
				Short: "The name of the EventFlow",
				Long:  "The name of the `EventFlow` component. Needed when the app has more than one.",
			},
		},
	},
	Flags: []cli.Flag{
		{
			Name: "name",
			Type: "string",
			Description: cli.Description{
				Short: "The name of the EventFlow, when there's more than one",
				Long:  "The name of the `EventFlow` component, when the app has more than one.",
			},
		},
		{
			Name: "json",
			Type: "bool",
			Description: cli.Description{
				Short: "Print the result as JSON",
				Long:  "Print the admin API's result as JSON.",
			},
		},
		{
			Name: "once",
			Type: "bool",
			Description: cli.Description{
				Short: "Print the live view once and exit",
				Long:  "Print the live view once and exit, instead of refreshing it.",
			},
		},
	},
	Examples: []cli.Example{
		{Content: "sst eventflow", Description: cli.Description{Short: "Watch the app's EventFlow"}},
		{Content: "sst eventflow Jobs --once", Description: cli.Description{Short: "Print the EventFlow called Jobs once"}},
	},
	Run: func(c *cli.Cli) error {
		if args := c.Arguments(); len(args) > 1 {
			return util.NewReadableError(nil, fmt.Sprintf("Unexpected %q. Put a subcommand first, like: sst eventflow %s --name %s", args[1], args[1], args[0]))
		}
		name := c.Positional(0)
		if flagName := c.String("name"); flagName != "" {
			if name != "" && name != flagName {
				return util.NewReadableError(nil, fmt.Sprintf("Pass the EventFlow's name once: %q or --name %q", name, flagName))
			}
			name = flagName
		}
		return withEventFlow(c, name, func(client *eventflow.Client, target eventflow.Target) error {
			return eventflowLive(c, client, target)
		})
	},
	Children: []*cli.Command{
		{
			Name: "functions",
			Description: cli.Description{
				Short: "List the functions",
				Long: strings.Join([]string{
					"List the EventFlow's functions, as its latest deploy has them: what triggers each one, its retries, its concurrency limits, throttle and rate limit, and the events that cancel its runs.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow functions",
					"```",
				}, "\n"),
			},
			Run: func(c *cli.Cli) error {
				return eventflowCall(c, "functions", nil, func(raw json.RawMessage) error {
					var functions []eventflow.Function
					if err := json.Unmarshal(raw, &functions); err != nil {
						return err
					}
					eventflow.RenderFunctions(os.Stdout, functions)
					return nil
				})
			},
		},
		{
			Name: "runs",
			Description: cli.Description{
				Short: "List the runs",
				Long: strings.Join([]string{
					"List the runs, the latest first. By default, the latest 100.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow runs",
					"```",
					"",
					"Pick the runs with the flags. For example, the failed runs of the `send-welcome` function in the last hour:",
					"",
					"```bash frame=\"none\"",
					"sst eventflow runs --function send-welcome --status FAILED --since 1h",
					"```",
				}, "\n"),
			},
			Flags: eventflowListFlags,
			Run: func(c *cli.Cli) error {
				args, err := eventflowFlags(c).Args(time.Now())
				if err != nil {
					return err
				}
				return eventflowCall(c, "runs.list", args, func(raw json.RawMessage) error {
					var runs []eventflow.RunSummary
					if err := json.Unmarshal(raw, &runs); err != nil {
						return err
					}
					eventflow.RenderRuns(os.Stdout, runs, time.Now())
					return nil
				})
			},
		},
		{
			Name: "run",
			Description: cli.Description{
				Short: "Show a run",
				Long: strings.Join([]string{
					"Show a run: the event that started it, each of its steps, the step that failed and its error, and where its logs are.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow run send-welcome-01JD3T9V6Q8X7N2M4K5P0R1S2T",
					"```",
					"",
					"Add `--all-steps` to also see the steps the engine adds, like taking a concurrency lease.",
				}, "\n"),
			},
			Args: []cli.Argument{eventflowRunArg},
			Flags: []cli.Flag{
				{
					Name: "all-steps",
					Type: "bool",
					Description: cli.Description{
						Short: "Show the engine's own steps too",
						Long:  "Also show the steps the engine adds, like taking a concurrency lease, and the parts of a wait or an invoke.",
					},
				},
			},
			Run: func(c *cli.Cli) error {
				runID := c.Positional(0)
				return eventflowCall(c, "runs.get", eventflow.RunArgs(runID), func(raw json.RawMessage) error {
					var run *eventflow.Run
					if err := json.Unmarshal(raw, &run); err != nil {
						return err
					}
					if run == nil {
						return util.NewReadableError(nil, fmt.Sprintf("There's no run %q", runID))
					}
					eventflow.RenderRun(os.Stdout, run, time.Now(), c.Bool("all-steps"))
					return nil
				})
			},
		},
		eventflowRerunCommand("retry"),
		eventflowRerunCommand("replay"),
		{
			Name: "cancel",
			Description: cli.Description{
				Short: "Cancel a run, or many",
				Long: strings.Join([]string{
					"Cancel a run that's running. It stops where it is, and its steps that haven't run don't run.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow cancel send-welcome-01JD3T9V6Q8X7N2M4K5P0R1S2T",
					"```",
					"",
					"A run that another run invoked fails that run's invoke, so it doesn't wait for it.",
					"",
					"Pass `--all` instead of a run ID to cancel every run that's running or paused, up to 500 at a time, or the ones the flags pick. Do this before you remove an EventFlow with many runs in flight: `sst remove` stops them one at a time.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow cancel --all --function send-welcome",
					"```",
				}, "\n"),
			},
			Args: []cli.Argument{
				{
					Name: "runId",
					Description: cli.Description{
						Short: "The ID of the run",
						Long:  "The ID of the run. Leave it out with `--all`.",
					},
				},
			},
			Flags: append([]cli.Flag{
				{
					Name: "all",
					Type: "bool",
					Description: cli.Description{
						Short: "Cancel the runs in flight",
						Long:  "Cancel every run that's running or paused, or the ones the other flags pick, instead of one run.",
					},
				},
				eventflowYesFlag,
			}, eventflowListFlags...),
			Run: func(c *cli.Cli) error {
				runID := c.Positional(0)
				if c.Bool("all") {
					if runID != "" {
						return util.NewReadableError(nil, "Pass a run ID or --all, not both")
					}
					args, err := eventflowFlags(c).CancelAllArgs(time.Now())
					if err != nil {
						return err
					}
					if err := eventflowConfirm(c, "Cancel every run that's running or paused, that the flags pick?"); err != nil {
						return err
					}
					return eventflowCall(c, "runs.cancelAll", args, func(raw json.RawMessage) error {
						var results []eventflow.CancelResult
						if err := json.Unmarshal(raw, &results); err != nil {
							return err
						}
						if eventflow.RenderCancelAll(os.Stdout, results) > 0 {
							return util.NewReadableError(nil, "")
						}
						return nil
					})
				}
				if runID == "" {
					return util.NewReadableError(nil, "Pass the ID of the run to cancel, or --all for the runs in flight")
				}
				return eventflowCall(c, "runs.cancel", eventflow.RunArgs(runID), func(raw json.RawMessage) error {
					var result eventflow.Cancelled
					if err := json.Unmarshal(raw, &result); err != nil {
						return err
					}
					if result.Stopped {
						ui.Success(fmt.Sprintf("Cancelled the run %s", result.ID))
					} else {
						fmt.Println(ui.TEXT_DIM.Render(fmt.Sprintf("The run %s wasn't running, so nothing was cancelled", result.ID)))
					}
					return nil
				})
			},
		},
		{
			Name: "dead-letters",
			Description: cli.Description{
				Short: "Show or redrive the dead letters",
				Long: strings.Join([]string{
					"Show the messages in the EventFlow's dead-letter queue: the events the router couldn't route after its retries. It looks at up to 10 without taking them off the queue.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow dead-letters",
					"```",
					"",
					"Once you've fixed what made them fail, move them all back to the queue, to be routed again, with `--redrive`.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow dead-letters --redrive",
					"```",
				}, "\n"),
			},
			Flags: []cli.Flag{
				{
					Name: "redrive",
					Type: "bool",
					Description: cli.Description{
						Short: "Move the dead letters back to the queue",
						Long:  "Move every dead letter back to the queue, to be routed again.",
					},
				},
				eventflowYesFlag,
			},
			Run: func(c *cli.Cli) error {
				if c.Bool("redrive") {
					if err := eventflowConfirm(c, "Move every dead letter back to the queue, to be routed again?"); err != nil {
						return err
					}
					return eventflowCall(c, "deadLetters.redrive", nil, func(raw json.RawMessage) error {
						var result eventflow.Redrive
						if err := json.Unmarshal(raw, &result); err != nil {
							return err
						}
						ui.Success("Moving the dead letters back to the queue, to be routed again")
						if result.TaskHandle != "" {
							fmt.Println(ui.TEXT_DIM.Render("   Task " + result.TaskHandle))
						}
						return nil
					})
				}
				return eventflowCall(c, "deadLetters.peek", map[string]any{"max": 10}, func(raw json.RawMessage) error {
					var letters []eventflow.DeadLetter
					if err := json.Unmarshal(raw, &letters); err != nil {
						return err
					}
					eventflow.RenderDeadLetters(os.Stdout, letters, time.Now())
					return nil
				})
			},
		},
		{
			Name: "send",
			Description: cli.Description{
				Short: "Send an event",
				Long: strings.Join([]string{
					"Send an event to the EventFlow, to start the functions it triggers or the runs waiting for it.",
					"",
					"```bash frame=\"none\"",
					"sst eventflow send order.created --data '{\"orderId\":\"123\"}'",
					"```",
					"",
					"Give it an ID with `--id`, so that sending it twice starts its functions once, and a tenant with `--tenant`.",
				}, "\n"),
			},
			Args: []cli.Argument{
				{
					Name:     "eventName",
					Required: true,
					Description: cli.Description{
						Short: "The name of the event",
						Long:  "The name of the event, like `order.created`.",
					},
				},
			},
			Flags: []cli.Flag{
				{
					Name: "data",
					Type: "string",
					Description: cli.Description{
						Short: "The event's data, as JSON",
						Long:  "The event's data, as JSON. Defaults to `{}`.",
					},
				},
				{
					Name: "id",
					Type: "string",
					Description: cli.Description{
						Short: "The event's ID",
						Long:  "The event's ID. One is made when it's not given.",
					},
				},
				{
					Name: "tenant",
					Type: "string",
					Description: cli.Description{
						Short: "The tenant the event belongs to",
						Long:  "The tenant the event belongs to.",
					},
				},
			},
			Run: func(c *cli.Cli) error {
				name := c.Positional(0)
				args, err := eventflow.SendArgs(name, c.String("data"), c.String("id"), c.String("tenant"))
				if err != nil {
					return err
				}
				return eventflowCall(c, "send", args, func(raw json.RawMessage) error {
					var result eventflow.Sent
					if err := json.Unmarshal(raw, &result); err != nil {
						return err
					}
					ui.Success(fmt.Sprintf("Sent %s as %s", name, strings.Join(result.IDs, ", ")))
					return nil
				})
			},
		},
	},
}

// eventflowRerunCommand is retry, or replay: of one run, or with --failed,
// of the failed runs
func eventflowRerunCommand(mode string) *cli.Command {
	op, verb, long := "runs.retry", "Retry", []string{
		"Retry a run that failed, as a new run on the latest deploy, with the same event. The steps that succeeded return their saved results instead of running again, so the retry picks up at the step that failed. This is how you rerun a run after deploying a fix.",
		"",
		"```bash frame=\"none\"",
		"sst eventflow retry send-welcome-01JD3T9V6Q8X7N2M4K5P0R1S2T",
		"```",
		"",
		"To run every step again, use `sst eventflow replay` instead.",
	}
	past := "retried"
	if mode == "replay" {
		past = "replayed"
		op, verb, long = "runs.replay", "Replay", []string{
			"Replay a run, as a new run on the latest deploy, with the same event. Every step runs again, including the ones that succeeded.",
			"",
			"```bash frame=\"none\"",
			"sst eventflow replay send-welcome-01JD3T9V6Q8X7N2M4K5P0R1S2T",
			"```",
			"",
			"To reuse the results of the steps that succeeded, use `sst eventflow retry` instead.",
		}
	}
	long = append(long,
		"",
		fmt.Sprintf("Pass `--failed` instead of a run ID to %s the failed runs, up to %d of them, the latest 50 by default. Pick them with the flags. For example, the failed runs of the `send-welcome` function in the last hour:", strings.ToLower(verb), eventflow.MaxRetryAll),
		"",
		"```bash frame=\"none\"",
		fmt.Sprintf("sst eventflow %s --failed --function send-welcome --since 1h", mode),
		"```",
		"",
		"It prints what happened to each run. With `--status`, it picks the runs with that status instead, like `TIMED_OUT`.",
		"",
		"A run whose `atMostOnce` step stopped part way may already have done that step's side effect, like a payment. It isn't rerun unless you pass `--force`, after you've checked it.",
		"",
		fmt.Sprintf("A run is %s once. Asking again, as from a script that runs twice, prints the run it was %s as. Pass `--again` to %s it again on purpose.", past, past, strings.ToLower(verb)),
		"",
		"With `--failed`, it asks before it starts. Pass `--yes` to skip that, as in CI.",
	)
	return &cli.Command{
		Name: mode,
		Description: cli.Description{
			Short: verb + " a run, or the failed runs",
			Long:  strings.Join(long, "\n"),
		},
		Args: []cli.Argument{
			{
				Name: "runId",
				Description: cli.Description{
					Short: "The ID of the run",
					Long:  "The ID of the run. Leave it out with `--failed`.",
				},
			},
		},
		Flags: append([]cli.Flag{
			{
				Name: "failed",
				Type: "bool",
				Description: cli.Description{
					Short: verb + " the failed runs",
					Long:  verb + " the failed runs that the other flags pick, instead of one run.",
				},
			},
			{
				Name: "force",
				Type: "bool",
				Description: cli.Description{
					Short: "Also rerun runs whose step stopped part way",
					Long:  "A run whose `atMostOnce` step stopped part way may have done that step's side effect, like a payment, so it isn't rerun unless you pass `--force`. Check it first.",
				},
			},
			{
				Name: "again",
				Type: "bool",
				Description: cli.Description{
					Short: verb + " a run that was already " + past,
					Long:  "A run is " + past + " once: asking again prints the run it was " + past + " as, so a double click or a script that runs twice doesn't start a second one. Pass `--again` to " + strings.ToLower(verb) + " it again, on purpose.",
				},
			},
			eventflowYesFlag,
		}, eventflowListFlags...),
		Run: func(c *cli.Cli) error {
			runID := c.Positional(0)
			flags := eventflowFlags(c)
			if !c.Bool("failed") {
				if runID == "" {
					return util.NewReadableError(nil, fmt.Sprintf("Pass the ID of the run to %s, or --failed for the failed runs", mode))
				}
				if flags != (eventflow.ListFlags{}) {
					return util.NewReadableError(nil, "--function, --status, --since and --limit pick the runs with --failed")
				}
				runArgs := eventflow.RunArgs(runID)
				if c.Bool("force") {
					runArgs["force"] = true
				}
				if c.Bool("again") {
					runArgs["again"] = true
				}
				return eventflowCall(c, op, runArgs, func(raw json.RawMessage) error {
					var result eventflow.Rerun
					if err := json.Unmarshal(raw, &result); err != nil {
						return err
					}
					eventflow.RenderRerun(os.Stdout, mode, result)
					return nil
				})
			}
			if runID != "" {
				return util.NewReadableError(nil, "Pass a run ID or --failed, not both")
			}
			if c.Bool("again") {
				return util.NewReadableError(nil, "--again is for one run. With --failed, a run that was already "+past+" isn't "+past+" again")
			}
			args, err := flags.RetryAllArgs(mode, time.Now())
			if err != nil {
				return err
			}
			args.Force = c.Bool("force")
			question := fmt.Sprintf("%s the runs the flags pick?", verb)
			if args.Force {
				question = fmt.Sprintf("%s the runs the flags pick, including ones whose atMostOnce step may have done its side effect?", verb)
			}
			if err := eventflowConfirm(c, question); err != nil {
				return err
			}
			return eventflowCall(c, "runs.retryAll", args, func(raw json.RawMessage) error {
				var results []eventflow.RerunResult
				if err := json.Unmarshal(raw, &results); err != nil {
					return err
				}
				if eventflow.RenderRerunAll(os.Stdout, mode, results) > 0 {
					// the summary says which: exit with an error, and nothing more
					return util.NewReadableError(nil, "")
				}
				return nil
			})
		},
	}
}

func eventflowFlags(c *cli.Cli) eventflow.ListFlags {
	return eventflow.ListFlags{
		Function: c.String("function"),
		Status:   c.String("status"),
		Since:    c.String("since"),
		Limit:    c.String("limit"),
	}
}

// withEventFlow finds the EventFlow called name in the stage's last deploy,
// or the only one, and runs fn with a client of its router that uses the
// developer's AWS credentials
func withEventFlow(c *cli.Cli, name string, fn func(*eventflow.Client, eventflow.Target) error) error {
	p, err := c.InitProject()
	if err != nil {
		return err
	}
	defer p.Cleanup()
	complete, err := p.GetCompleted(c.Context)
	if err != nil {
		return err
	}
	target, err := eventflow.Find(complete.Links, name)
	if err != nil {
		return err
	}
	aws, ok := p.Provider("aws")
	if !ok {
		return util.NewReadableError(nil, "An EventFlow needs the AWS provider, and this app doesn't have it")
	}
	return fn(eventflow.NewClient(aws.(*provider.AwsProvider).Config(), target.RouterName), target)
}

var eventflowYesFlag = cli.Flag{
	Name: "yes",
	Type: "bool",
	Description: cli.Description{
		Short: "Don't ask first",
		Long:  "Do it without asking first. Without a terminal to ask in, as in CI, it's needed.",
	},
}

// eventflowConfirm asks before an action on many runs or messages, unless
// --yes. With no terminal to ask in, it needs --yes.
func eventflowConfirm(c *cli.Cli, question string) error {
	if c.Bool("yes") {
		return nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return util.NewReadableError(nil, "This acts on many runs at once. Pass --yes to do it without being asked")
	}
	fmt.Print(question + " (y/N): ")
	var response string
	fmt.Scanln(&response)
	if r := strings.ToLower(strings.TrimSpace(response)); r != "y" && r != "yes" {
		return util.NewReadableError(nil, "Nothing was done")
	}
	return nil
}

// eventflowCall calls op on the EventFlow --name picks, and prints its result
// as JSON with --json, or with render
func eventflowCall(c *cli.Cli, op string, args any, render func(json.RawMessage) error) error {
	return withEventFlow(c, c.String("name"), func(client *eventflow.Client, _ eventflow.Target) error {
		raw, err := client.Call(c.Context, op, args, nil)
		if err != nil {
			return err
		}
		if c.Bool("json") {
			return printEventflowJSON(raw)
		}
		return render(raw)
	})
}

func printEventflowJSON(value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

// eventflowLive prints the live view every 2 seconds until Ctrl-C, or once
// with --once
func eventflowLive(c *cli.Cli, client *eventflow.Client, target eventflow.Target) error {
	once := c.Bool("once")
	asJSON := c.Bool("json")
	tty := term.IsTerminal(int(os.Stdout.Fd()))
	var last *eventflow.Snapshot
	ticker := time.NewTicker(eventflowRefresh)
	defer ticker.Stop()
	for {
		snapshot, raw, err := client.Snapshot(c.Context)
		if c.Context.Err() != nil {
			return nil
		}
		// a failure on the first look, or the only one, is the command's
		if err != nil && (last == nil || once) {
			return err
		}
		if err == nil {
			last = &snapshot
		}
		if asJSON {
			if once {
				return printEventflowJSON(raw)
			}
			// a line a look
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
			} else if data, err := json.Marshal(raw); err == nil {
				fmt.Println(string(data))
			}
		} else {
			var buf bytes.Buffer
			if tty && !once {
				// to the top, and clear the screen
				buf.WriteString("\033[H\033[2J")
			}
			eventflow.RenderSnapshot(&buf, target.Name, *last, time.Now())
			if err != nil {
				buf.WriteString("\n" + ui.TEXT_DANGER.Render("Could not refresh: "+err.Error()) + "\n")
			}
			if !once {
				buf.WriteString("\n" + ui.TEXT_DIM.Render(fmt.Sprintf("Refreshing every %s. Press Ctrl-C to stop.", eventflowRefresh)) + "\n")
			}
			os.Stdout.Write(buf.Bytes())
			if once {
				return nil
			}
		}
		select {
		case <-c.Context.Done():
			return nil
		case <-ticker.C:
		}
	}
}
