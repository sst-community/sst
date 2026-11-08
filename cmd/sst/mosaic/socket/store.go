package socket

// sst dev keeps the most recent function calls for the tools that connect to
// its local socket: up to maxInvocations of them, and about
// maxInvocationBytes of their inputs, outputs and logs. The oldest go first.
// Without a limit every call was kept until sst dev exited, so a long session
// grew by the size of everything that passed through it.
const (
	maxInvocations     = 1_000
	maxInvocationBytes = 64 << 20
	// a single invocation keeps its newest lines
	maxInvocationLogs = 1_000
)

// invocationStore isn't safe for concurrent use. socket.go calls it only from
// its event loop.
type invocationStore struct {
	byID  map[string]*Invocation
	order []string // oldest first
	size  map[string]int
	total int
}

func newInvocationStore() *invocationStore {
	return &invocationStore{
		byID: map[string]*Invocation{},
		size: map[string]int{},
	}
}

// add stores a new invocation and drops the oldest ones over the limits.
func (s *invocationStore) add(invocation *Invocation) {
	if _, ok := s.byID[invocation.ID]; ok {
		s.remove(invocation.ID)
	}
	s.byID[invocation.ID] = invocation
	s.order = append(s.order, invocation.ID)
	s.size[invocation.ID] = 0
	s.grow(invocation.ID, len(invocation.Input))
}

func (s *invocationStore) get(id string) (*Invocation, bool) {
	invocation, ok := s.byID[id]
	return invocation, ok
}

// grow counts n more bytes for an invocation, and drops the oldest
// invocations over the limits. The newest one is always kept.
func (s *invocationStore) grow(id string, n int) {
	if _, ok := s.byID[id]; !ok {
		return
	}
	s.size[id] += n
	s.total += n
	for len(s.order) > 1 && (len(s.order) > maxInvocations || s.total > maxInvocationBytes) {
		s.remove(s.order[0])
	}
}

// log adds a line to an invocation, keeping its newest maxInvocationLogs.
func (s *invocationStore) log(id string, line InvocationLog) {
	invocation, ok := s.byID[id]
	if !ok {
		return
	}
	n := len(line.Message)
	if len(invocation.Logs) >= maxInvocationLogs {
		n -= len(invocation.Logs[0].Message)
		// copied, so the dropped lines aren't held by the old array
		invocation.Logs = append(invocation.Logs[:0:0], invocation.Logs[1:]...)
	}
	invocation.Logs = append(invocation.Logs, line)
	s.grow(id, n)
}

// clear drops the invocations of a source, or all of them for "all".
func (s *invocationStore) clear(source string) {
	for _, id := range append([]string{}, s.order...) {
		if source == "all" || s.byID[id].Source == source {
			s.remove(id)
		}
	}
}

// list returns the invocations, oldest first.
func (s *invocationStore) list() []*Invocation {
	all := make([]*Invocation, 0, len(s.order))
	for _, id := range s.order {
		all = append(all, s.byID[id])
	}
	return all
}

func (s *invocationStore) remove(id string) {
	if _, ok := s.byID[id]; !ok {
		return
	}
	s.total -= s.size[id]
	delete(s.byID, id)
	delete(s.size, id)
	for i, other := range s.order {
		if other == id {
			s.order = append(s.order[:i:i], s.order[i+1:]...)
			break
		}
	}
}
