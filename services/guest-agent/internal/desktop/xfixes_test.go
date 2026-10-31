package desktop

import (
	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xfixes"
	"io"
	"net"
	"testing"
	"time"
)

// Wire fixture follows xserver/xfixes/xfixes.c: only QueryVersion is
// permitted before negotiation. GetCursorImage becomes available in v1.
func TestXFixesNegotiatesBeforeCursorCapture(t *testing.T) {
	client, server := net.Pipe()
	_ = server.SetDeadline(time.Now().Add(3 * time.Second))
	defer server.Close()
	go func() {
		defer server.Close()
		hello := make([]byte, 12)
		if _, e := io.ReadFull(server, hello); e != nil {
			return
		}
		auth := make([]byte, xgb.Pad(int(xgb.Get16(hello[6:])))+xgb.Pad(int(xgb.Get16(hello[8:]))))
		if _, e := io.ReadFull(server, auth); e != nil {
			return
		}
		setup := make([]byte, 40)
		setup[0] = 1
		xgb.Put16(setup[2:], 11)
		xgb.Put16(setup[6:], 8)
		xgb.Put32(setup[12:], 1<<20)
		xgb.Put32(setup[16:], 0xffff)
		xgb.Put16(setup[26:], 65535)
		if _, e := server.Write(setup); e != nil {
			return
		}
		var seq uint16
		negotiated := false
		for {
			head := make([]byte, 4)
			if _, e := io.ReadFull(server, head); e != nil {
				return
			}
			seq++
			body := make([]byte, int(xgb.Get16(head[2:]))*4-4)
			if _, e := io.ReadFull(server, body); e != nil {
				return
			}
			reply := make([]byte, 32)
			reply[0] = 1
			xgb.Put16(reply[2:], seq)
			switch {
			case head[0] == 98:
				reply[8] = 1
				reply[9] = 134
				reply[10] = 64
				reply[11] = 128
			case head[0] == 134 && head[1] == 0:
				negotiated = true
				xgb.Put32(reply[8:], 1)
			case head[0] == 134 && head[1] == 4 && negotiated:
				reply = append(reply, 0, 0, 0, 255)
				xgb.Put32(reply[4:], 1)
				xgb.Put16(reply[12:], 1)
				xgb.Put16(reply[14:], 1)
			default:
				reply[0] = 0
				reply[1] = 1
				reply[10] = head[0]
			}
			if _, e := server.Write(reply); e != nil {
				return
			}
		}
	}()
	conn, err := xgb.NewConnNet(client)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = initXFixes(conn); err != nil {
		t.Fatal(err)
	}
	cursor, err := xfixes.GetCursorImage(conn).Reply()
	if err != nil || cursor == nil || cursor.Width != 1 {
		t.Fatalf("cursor request before negotiated XFixes: %v", err)
	}
}
