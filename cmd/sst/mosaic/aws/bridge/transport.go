package bridge

import (
	"context"
	"errors"
)

// Transport is how the stub deployed in place of a function in sst dev
// reaches the CLI: what the stub is given, the connection both sides publish
// and subscribe on, and what it leaves outside the state. AppSync's Event API
// is the built-in one.
//
// A transport only delivers events. The bridge does the rest over its Conn: it
// cuts a message into packets, puts them back in order and drops copies. For
// what's lost, the receiver of a streamed message asks for the packets it's
// missing, and sst dev sends a reply again a few times, with its ID. So a Conn
// has to do this much, and no more:
//
//   - Publish delivers an event to whoever subscribes to its channel at the
//     time. An event published to a channel with no subscriber is lost. One
//     may also be lost otherwise, arrive out of order, or arrive twice.
//   - Publish returns an error when the event may not have been sent. It may
//     return none and the event still be lost.
//   - Subscribe returns a channel of the events published to the channel,
//     each as the JSON it was published as. A new subscription may miss events
//     for a moment after Subscribe returns. The subscription lasts as long as
//     the connection: a transport that loses its connection subscribes again by
//     itself, and events published meanwhile may be lost. The channel may be
//     closed when the connection ends.
//   - An event as large as the bridge's largest packet is delivered whole:
//     BUFFER_SIZE bytes of a message, about 175 KB once encoded.
//   - The events for a subscriber that's slow to read may be held up or lost.
//     The bridge reads its subscription as events arrive.
//   - Publish and Subscribe are called from many goroutines at once.
//   - A Conn that publishes several events in one request, with PublishBatch,
//     takes as many as packetsPerPublish.
//
// The stub's own loop runs over a Connection: a Conn it can also make connect
// again after a Lambda freeze.
type Transport interface {
	// Stub is what the stub is given: its environment, and the permissions its
	// role needs. The program asks for it in sst dev, at the same time as sst
	// dev connects, and in sst deploy --dev and sst diff --dev, without sst
	// dev. So it finds or creates what the transport needs outside the state,
	// like the Event API, itself. It should give the same from one run to the
	// next, or each one redeploys every stub. The stub speaks AppSync's
	// protocol unless its environment says otherwise.
	Stub(ctx context.Context) (*StubSettings, error)
	// Connect opens the CLI's side of the connection, and finds or creates
	// what the transport needs outside the state. An error wrapping
	// ErrNotReady is one that may pass if sst dev starts again.
	Connect(ctx context.Context) (Conn, error)
	// Remove removes what the transport made outside the state for the stage,
	// if it's the stage's own, when the stage is removed. It's no error that
	// there's nothing to remove, or that the credentials can't look.
	Remove(ctx context.Context) error
}

// ErrNotReady is wrapped by an error from Transport.Connect when what the
// transport needs isn't answering yet, as a new Event API can take a moment.
var ErrNotReady = errors.New("the transport isn't ready")

// StubSettings is what the stub is deployed with to reach the CLI.
type StubSettings struct {
	// Environment is added to the stub's environment.
	Environment map[string]string `json:"environment"`
	// Permissions are added to the role the stub runs as.
	Permissions []StubPermission `json:"permissions"`
}

// StubPermission is an IAM statement that allows the actions on the resources.
type StubPermission struct {
	Actions   []string `json:"actions"`
	Resources []string `json:"resources"`
}
