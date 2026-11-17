package transporttest

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
)

// memory is a transport in memory that does what a Conn has to and no more:
// an event goes to whoever subscribes to its channel at the time, as JSON.
type memory struct {
	mu   sync.Mutex
	subs map[string][]chan string
}

func (m *memory) Publish(ctx context.Context, channel string, event any) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	m.mu.Lock()
	subs := m.subs[channel]
	m.mu.Unlock()
	for _, sub := range subs {
		select {
		case sub <- string(data):
		default: // a subscriber that's behind loses it
		}
	}
	return nil
}

func (m *memory) Subscribe(ctx context.Context, channel string) (chan string, error) {
	sub := make(chan string, 1000)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.subs == nil {
		m.subs = map[string][]chan string{}
	}
	m.subs[channel] = append(m.subs[channel], sub)
	return sub, nil
}

var _ bridge.Conn = (*memory)(nil)

// It has no connection to lose, so it's not reconnected.
func TestMemory(t *testing.T) {
	transport := &memory{}
	Run(t, Options{Connect: func(t *testing.T) bridge.Conn { return transport }})
}
