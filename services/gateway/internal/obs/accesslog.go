package obs

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"time"
)

// AccessLog writes one JSON line per finished request or SSH session. It is
// safe for concurrent use. Session contents are never logged.
type AccessLog struct {
	mu  sync.Mutex
	w   io.Writer
	now func() time.Time
}

// NewAccessLog returns a log that writes to w.
func NewAccessLog(w io.Writer) *AccessLog {
	return &AccessLog{w: w, now: time.Now}
}

// HTTPEntry is one HTTP access log line (spec section 12.2). Every field is
// always written, so the line schema is stable.
type HTTPEntry struct {
	Time          time.Time // zero means now
	RequestID     string
	ClientIP      string
	Host          string
	Label         string
	SandboxID     string
	MachineID     string
	Port          int
	Method        string
	Path          string // a query part is dropped on write
	Status        int
	UmiakError      string
	BytesIn       int64
	BytesOut      int64
	DurationMs    int64
	TTFBMs        int64
	Access        string
	AuthResult    string
	UserID        string
	Upgrade       string // "websocket" or empty
	Via           string // "local" or "peer"
	OwnerInstance string
	UserAgent     string
}

type httpLine struct {
	Time          string `json:"time"`
	RequestID     string `json:"requestId"`
	ClientIP      string `json:"clientIp"`
	Host          string `json:"host"`
	Label         string `json:"label"`
	SandboxID     string `json:"sandboxId"`
	MachineID     string `json:"machineId"`
	Port          int    `json:"port"`
	Method        string `json:"method"`
	Path          string `json:"path"`
	Status        int    `json:"status"`
	UmiakError      string `json:"umiakError"`
	BytesIn       int64  `json:"bytesIn"`
	BytesOut      int64  `json:"bytesOut"`
	DurationMs    int64  `json:"durationMs"`
	TTFBMs        int64  `json:"ttfbMs"`
	Access        string `json:"access"`
	AuthResult    string `json:"authResult"`
	UserID        string `json:"userId"`
	Upgrade       string `json:"upgrade"`
	Via           string `json:"via"`
	OwnerInstance string `json:"ownerInstance"`
	UserAgent     string `json:"userAgent"`
}

// HTTP writes one access log line.
func (l *AccessLog) HTTP(e HTTPEntry) {
	t := e.Time
	if t.IsZero() {
		t = l.now()
	}
	l.write(httpLine{
		Time:          t.UTC().Format(time.RFC3339Nano),
		RequestID:     e.RequestID,
		ClientIP:      e.ClientIP,
		Host:          e.Host,
		Label:         e.Label,
		SandboxID:     e.SandboxID,
		MachineID:     e.MachineID,
		Port:          e.Port,
		Method:        e.Method,
		Path:          stripQuery(e.Path),
		Status:        e.Status,
		UmiakError:      e.UmiakError,
		BytesIn:       e.BytesIn,
		BytesOut:      e.BytesOut,
		DurationMs:    e.DurationMs,
		TTFBMs:        e.TTFBMs,
		Access:        e.Access,
		AuthResult:    e.AuthResult,
		UserID:        e.UserID,
		Upgrade:       e.Upgrade,
		Via:           e.Via,
		OwnerInstance: e.OwnerInstance,
		UserAgent:     e.UserAgent,
	})
}

// SSHEntry is one SSH session log line, written when the session ends.
type SSHEntry struct {
	SessionID   string
	ClientIP    string
	ActorKind   string // "user" or "api_key"
	UserID      string
	APIKeyID    string
	Fingerprint string // key fingerprint, when a plain key logged in
	CertSerial  uint64 // certificate serial, when a certificate logged in
	SandboxID   string
	Start       time.Time
	End         time.Time
	BytesIn     int64
	BytesOut    int64
	// BackendHostKey is the fingerprint of the VM sshd host key.
	BackendHostKey string
	// Channels counts the channels opened during the session by type.
	Channels    map[string]int
	CloseReason string
}

type sshLine struct {
	SessionID      string         `json:"sessionId"`
	ClientIP       string         `json:"clientIp"`
	ActorKind      string         `json:"actorKind"`
	UserID         string         `json:"userId,omitempty"`
	APIKeyID       string         `json:"apiKeyId,omitempty"`
	Fingerprint    string         `json:"fingerprint,omitempty"`
	CertSerial     uint64         `json:"certSerial,omitempty"`
	SandboxID      string         `json:"sandboxId"`
	Start          string         `json:"start"`
	End            string         `json:"end"`
	BytesIn        int64          `json:"bytesIn"`
	BytesOut       int64          `json:"bytesOut"`
	BackendHostKey string         `json:"backendHostKey,omitempty"`
	Channels       map[string]int `json:"channels"`
	CloseReason    string         `json:"closeReason"`
}

// SSH writes one SSH session line.
func (l *AccessLog) SSH(e SSHEntry) {
	ch := e.Channels
	if ch == nil {
		ch = map[string]int{}
	}
	l.write(sshLine{
		SessionID:      e.SessionID,
		ClientIP:       e.ClientIP,
		ActorKind:      e.ActorKind,
		UserID:         e.UserID,
		APIKeyID:       e.APIKeyID,
		Fingerprint:    e.Fingerprint,
		CertSerial:     e.CertSerial,
		SandboxID:      e.SandboxID,
		Start:          e.Start.UTC().Format(time.RFC3339Nano),
		End:            e.End.UTC().Format(time.RFC3339Nano),
		BytesIn:        e.BytesIn,
		BytesOut:       e.BytesOut,
		BackendHostKey: e.BackendHostKey,
		Channels:       ch,
		CloseReason:    e.CloseReason,
	})
}

func (l *AccessLog) write(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return // cannot happen for these types
	}
	b = append(b, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(b)
}

// stripQuery removes the query and the fragment: queries carry _token and
// application secrets.
func stripQuery(p string) string {
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		return p[:i]
	}
	return p
}
