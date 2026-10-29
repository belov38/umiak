package shim

// maxSessions bounds the input sessions the shim remembers; with the
// session id length limit of the server it keeps a status reply far below shimproto.MaxFrame.
const maxSessions = 1024

// seqTable holds the last applied input seq per session, dropping the least
// recently used session beyond its capacity. A dropped session starts over:
// a late duplicate of it would be applied again, which needs more than
// maxSessions newer sessions in between.
type seqTable struct {
	limit int
	clock uint64
	m     map[string]seqEntry
}

type seqEntry struct {
	seq  uint64
	used uint64
}

func newSeqTable(limit int) seqTable {
	return seqTable{limit: limit, m: make(map[string]seqEntry)}
}

// last returns the last applied seq of session (0 if unknown).
func (t *seqTable) last(session string) uint64 {
	return t.m[session].seq
}

// set records seq as applied for session.
func (t *seqTable) set(session string, seq uint64) {
	t.clock++
	if _, ok := t.m[session]; !ok && len(t.m) >= t.limit {
		oldest, oldestUsed := "", ^uint64(0)
		for k, e := range t.m {
			if e.used < oldestUsed {
				oldest, oldestUsed = k, e.used
			}
		}
		delete(t.m, oldest)
	}
	t.m[session] = seqEntry{seq: seq, used: t.clock}
}

// snapshot returns a copy of the table as session -> seq.
func (t *seqTable) snapshot() map[string]uint64 {
	out := make(map[string]uint64, len(t.m))
	for k, e := range t.m {
		out[k] = e.seq
	}
	return out
}
