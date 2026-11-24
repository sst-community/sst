// Package host is the console's host module: the machine's CPU, memory, swap
// and load, and sst dev's own CPU, memory, heap, goroutines and what its bus
// subscribers lost.
//
// It samples only while a page shows it, every two seconds, and off the
// console's dispatcher.
//
// Messages, of module "host":
//
//   - "sample": a Sample. A snapshot sends the samples kept, oldest first.
package host

import (
	"context"
	"embed"
	"io/fs"
	"os"
	goruntime "runtime"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
	"github.com/sst/sst/v3/pkg/bus"
)

//go:embed web
var web embed.FS

const (
	interval = 2 * time.Second
	// five minutes of samples
	history = 150
)

type Module struct{}

func (Module) Name() string  { return "host" }
func (Module) Title() string { return "Host" }
func (Module) Web() fs.FS    { return must(fs.Sub(web, "web")) }

// Sample is the machine and sst dev at a time. CPU is a percent of the whole
// machine, and the process's of one core. Sizes are in bytes. Load is nil
// where there's none, as on Windows.
type Sample struct {
	T       int64    `json:"t"`
	Machine Machine  `json:"machine"`
	Process Process  `json:"process"`
	Bus     []BusSub `json:"bus"`
}

type Machine struct {
	CPU       float64     `json:"cpu"`
	Cores     int         `json:"cores"`
	MemTotal  uint64      `json:"memTotal"`
	MemUsed   uint64      `json:"memUsed"`
	SwapTotal uint64      `json:"swapTotal"`
	SwapUsed  uint64      `json:"swapUsed"`
	Load      *[3]float64 `json:"load,omitempty"`
}

type Process struct {
	CPU        float64 `json:"cpu"`
	RSS        uint64  `json:"rss"`
	Heap       uint64  `json:"heap"`
	Sys        uint64  `json:"sys"`
	Goroutines int     `json:"goroutines"`
	GCPauseNs  uint64  `json:"gcPauseNs"`
}

// BusSub is one of the bus's subscribers: Queued is its backlog now, and
// Dropped what it lost since sst dev started.
type BusSub struct {
	Label   string `json:"label"`
	Lossy   bool   `json:"lossy"`
	Queued  int    `json:"queued"`
	Dropped uint64 `json:"dropped"`
}

type store struct {
	c        *console.Console
	samples  []Sample
	sampling bool
	last     time.Time
	self     *process.Process
	cpu      float64
	cores    int
}

func (Module) Start(ctx context.Context, c *console.Console) error {
	s := &store{c: c, cores: goruntime.NumCPU()}
	s.self, _ = process.NewProcessWithContext(ctx, int32(os.Getpid()))
	c.Every(func(now time.Time) {
		if s.sampling || !c.Watched("host") || now.Sub(s.last) < interval {
			return
		}
		s.sampling = true
		since, before := s.last, s.cpu
		go func() {
			smp, used := s.sample(ctx, since, before)
			c.Do(ctx, func() {
				s.sampling = false
				s.last = c.Now()
				s.cpu = used
				smp.T = s.last.UnixMilli()
				s.samples = append(s.samples, smp)
				if len(s.samples) > history {
					s.samples = s.samples[len(s.samples)-history:]
				}
				c.Emit("host", "sample", smp)
			})
		}()
	})
	c.Snapshot("host", func() []console.Message {
		out := make([]console.Message, 0, len(s.samples))
		for _, smp := range s.samples {
			out = append(out, c.Message("host", "sample", smp))
		}
		return out
	})
	return nil
}

// sample reads the machine and this process. before is the CPU seconds this
// process had used at the sample of since.
func (s *store) sample(ctx context.Context, since time.Time, before float64) (Sample, float64) {
	smp := Sample{Machine: Machine{Cores: s.cores}}
	// since the last call: the first is since the machine started
	if pct, err := cpu.PercentWithContext(ctx, 0, false); err == nil && len(pct) > 0 {
		smp.Machine.CPU = pct[0]
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		smp.Machine.MemTotal, smp.Machine.MemUsed = vm.Total, vm.Used
	}
	if sw, err := mem.SwapMemoryWithContext(ctx); err == nil {
		smp.Machine.SwapTotal, smp.Machine.SwapUsed = sw.Total, sw.Used
	}
	if avg, err := load.AvgWithContext(ctx); err == nil {
		smp.Machine.Load = &[3]float64{avg.Load1, avg.Load5, avg.Load15}
	}
	used := before
	if s.self != nil {
		if times, err := s.self.TimesWithContext(ctx); err == nil {
			used = times.User + times.System
			if !since.IsZero() {
				if elapsed := time.Since(since).Seconds(); elapsed > 0 {
					smp.Process.CPU = (used - before) / elapsed * 100
				}
			}
		}
		if m, err := s.self.MemoryInfoWithContext(ctx); err == nil {
			smp.Process.RSS = m.RSS
		}
	}
	var ms goruntime.MemStats
	goruntime.ReadMemStats(&ms)
	smp.Process.Heap = ms.HeapAlloc
	smp.Process.Sys = ms.Sys
	smp.Process.GCPauseNs = ms.PauseTotalNs
	smp.Process.Goroutines = goruntime.NumGoroutine()
	for _, st := range bus.Stats() {
		smp.Bus = append(smp.Bus, BusSub{Label: st.Label, Lossy: st.Lossy, Queued: st.Queued, Dropped: st.Dropped})
	}
	return smp, used
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
