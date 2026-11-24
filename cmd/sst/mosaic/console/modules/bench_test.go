package modules

import (
	"fmt"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

// BenchmarkInvocation is what the console's dispatcher spends on one
// invocation's events, with every module on: invoked, three lines it prints,
// and its response. With a page open, that includes marshalling what it's
// sent.
func BenchmarkInvocation(b *testing.B) {
	input := []byte(`{"version":"2.0","rawPath":"/cart/1","headers":{"user-agent":"curl/8.7.1"}}`)
	line := `{"level":30,"time":1732400000000,"msg":"request","path":"/cart/1","requestId":"c264e645"}`
	for _, page := range []bool{false, true} {
		name := "no page"
		if page {
			name = "page open"
		}
		b.Run(name, func(b *testing.B) {
			h, err := console.NewHarness(All...)
			if err != nil {
				b.Fatal(err)
			}
			if page {
				h.Watch("logs", "invocations", "deploy", "stats", "workers", "host")
			}
			now := time.Now()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				fn := fmt.Sprintf("F%d", i%20)
				worker := fmt.Sprintf("w%d", i%40)
				req := fmt.Sprintf("r%d", i)
				h.Publish(&aws.FunctionInvokedEvent{FunctionID: fn, WorkerID: worker, RequestID: req, Input: input}, now)
				for j := 0; j < 3; j++ {
					h.Publish(&aws.FunctionLogEvent{FunctionID: fn, WorkerID: worker, RequestID: req, Line: line}, now)
				}
				h.Publish(&aws.FunctionResponseEvent{FunctionID: fn, WorkerID: worker, RequestID: req, Output: []byte(`{"ok":true}`)}, now)
				if page && i%512 == 0 {
					// a page reads what it's sent
					h.Messages()
				}
			}
			b.StopTimer()
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/5, "ns/event")
		})
	}
}
