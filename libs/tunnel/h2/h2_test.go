package h2_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	xhttp2 "golang.org/x/net/http2"

	"github.com/belov38/umiak/libs/tunnel/h2"
)

func TestServerSettings(t *testing.T) {
	srv := h2.NewServer(http.NotFoundHandler(), h2.DefaultServerConfig())
	ln := h2.New()
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close() })
	if err := ln.Push(server); err != nil {
		t.Fatal(err)
	}

	_ = client.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(client, xhttp2.ClientPreface); err != nil {
		t.Fatal(err)
	}
	fr := xhttp2.NewFramer(client, client)
	// Reading and writing on net.Pipe are synchronous: write our SETTINGS in the background.
	werr := make(chan error, 1)
	go func() { werr <- fr.WriteSettings() }()

	got := map[xhttp2.SettingID]uint32{}
	var connWindow uint32
	var sawSettings bool
	for !sawSettings || connWindow == 0 {
		f, err := fr.ReadFrame()
		if err != nil {
			t.Fatalf("read frame: %v (settings=%v, window=%d)", err, got, connWindow)
		}
		switch f := f.(type) {
		case *xhttp2.SettingsFrame:
			if f.IsAck() {
				continue
			}
			sawSettings = true
			_ = f.ForeachSetting(func(s xhttp2.Setting) error {
				got[s.ID] = s.Val
				return nil
			})
		case *xhttp2.WindowUpdateFrame:
			if f.StreamID == 0 {
				connWindow = f.Increment + 65535
			}
		}
	}
	if err := <-werr; err != nil {
		t.Fatal(err)
	}

	want := map[xhttp2.SettingID]uint32{
		xhttp2.SettingMaxConcurrentStreams: 1000,
		xhttp2.SettingInitialWindowSize:    1 << 20,
		xhttp2.SettingMaxFrameSize:         16384,
	}
	for id, v := range want {
		if got[id] != v {
			t.Errorf("%v = %d, want %d", id, got[id], v)
		}
	}
	if connWindow != 16<<20 {
		t.Errorf("connection window = %d, want %d", connWindow, 16<<20)
	}
}

func TestClientConnOverPipe(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			if r.Host != "localhost:22" {
				http.Error(w, "bad authority "+r.Host, http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			// Echo until the client half-closes, then send a final marker.
			fl := w.(http.Flusher)
			buf := make([]byte, 1024)
			for {
				n, err := r.Body.Read(buf)
				if n > 0 {
					_, _ = w.Write(buf[:n])
					fl.Flush()
				}
				if err != nil {
					break
				}
			}
			_, _ = io.WriteString(w, "|eof")
			return
		}
		for range 3 {
			_, _ = io.WriteString(w, "chunk\n")
			w.(http.Flusher).Flush()
		}
	})
	srv := h2.NewServer(handler, h2.DefaultServerConfig())
	ln := h2.New()
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	clientEnd, serverEnd := net.Pipe()
	if err := ln.Push(serverEnd); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cc, err := h2.NewClientConn(ctx, clientEnd, h2.DefaultClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cc.Close() })

	// Streaming GET.
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent:80/stream", nil)
	resp, err := cc.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "chunk\nchunk\nchunk\n" {
		t.Fatalf("body = %q", body)
	}

	// CONNECT with half-close.
	pr, pw := io.Pipe()
	creq, _ := http.NewRequestWithContext(ctx, http.MethodConnect, "", pr)
	creq.Host = "localhost:22"
	creq.URL.Host = "localhost:22"
	cresp, err := cc.RoundTrip(creq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cresp.Body.Close() }()
	if cresp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status = %d", cresp.StatusCode)
	}
	if _, err := io.WriteString(pw, "hello"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(cresp.Body, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "hello" {
		t.Fatalf("echo = %q", buf)
	}
	_ = pw.Close() // half-close: server sees EOF on the request body
	rest, err := io.ReadAll(cresp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(rest), "|eof") {
		t.Fatalf("after half-close = %q", rest)
	}
}
