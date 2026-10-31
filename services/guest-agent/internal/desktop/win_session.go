package desktop

import (
	"context"
	"encoding/binary"
	"errors"
	"image"
	"sync"
	"time"
	"unicode/utf16"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// WinInput is the portable representation of an amd64 Win32 INPUT record.
type WinInput struct {
	Type        uint32
	X, Y        int32
	Data, Flags uint32
	Key, Scan   uint16
}

// WindowsDesktop is implemented by Win32 in the interactive console, and fakes in tests.
type WindowsDesktop interface {
	Screen() (*v1.DesktopSize, *v1.DesktopPoint, error)
	Capture(bool) (image.Image, error)
	Send([]WinInput) error
	Key(string) (uint16, byte, error)
	GetClipboard() (string, bool, error)
	SetClipboard(string) error
}

// WinSession translates public actions independently of SCM or session zero.
type WinSession struct {
	API WindowsDesktop
	mu  sync.Mutex
}

// State reports whether the interactive input desktop is available.
func (s *WinSession) State(ctx context.Context) (*v1.DesktopSize, *v1.DesktopPoint, error) {
	if e := ctx.Err(); e != nil {
		return nil, nil, e
	}
	return s.API.Screen()
}

// Capture obtains a native GDI image without starting a streamer.
func (s *WinSession) Capture(ctx context.Context, cursor bool) (image.Image, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	return s.API.Capture(cursor)
}

// ClipboardGet reads CF_UNICODETEXT in the interactive session.
func (s *WinSession) ClipboardGet(ctx context.Context) (string, bool, error) {
	if e := ctx.Err(); e != nil {
		return "", false, e
	}
	return s.API.GetClipboard()
}

// ClipboardSet writes CF_UNICODETEXT in the interactive session.
func (s *WinSession) ClipboardSet(ctx context.Context, text string) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	return s.API.SetClipboard(text)
}

// Close releases the platform clipboard window.
func (s *WinSession) Close() error {
	if c, ok := s.API.(interface{ Close() error }); ok {
		return c.Close()
	}
	return nil
}
func encodeWinInputs(inputs []WinInput) []byte {
	out := make([]byte, 40*len(inputs))
	for i, input := range inputs {
		b := out[i*40:]
		binary.LittleEndian.PutUint32(b, input.Type)
		if input.Type == 1 {
			binary.LittleEndian.PutUint16(b[8:], input.Key)
			binary.LittleEndian.PutUint16(b[10:], input.Scan)
			binary.LittleEndian.PutUint32(b[12:], input.Flags)
		} else {
			binary.LittleEndian.PutUint32(b[8:], uint32(input.X))
			binary.LittleEndian.PutUint32(b[12:], uint32(input.Y))
			binary.LittleEndian.PutUint32(b[16:], input.Data)
			binary.LittleEndian.PutUint32(b[20:], input.Flags)
		}
	}
	return out
}
func (s *WinSession) press(key string, up bool) error {
	vk, mods, e := s.API.Key(key)
	if e != nil {
		return e
	}
	var inputs []WinInput
	for bit, v := range []uint16{0x10, 0x11, 0x12} {
		if mods&(1<<bit) != 0 {
			inputs = append(inputs, WinInput{Type: 1, Key: v})
		}
	}
	flags := uint32(0)
	if up {
		flags = 2
	}
	inputs = append(inputs, WinInput{Type: 1, Key: vk, Flags: flags})
	for bit, v := range []uint16{0x10, 0x11, 0x12} {
		if mods&(1<<bit) != 0 {
			inputs = append(inputs, WinInput{Type: 1, Key: v, Flags: 2})
		}
	}
	return s.API.Send(inputs)
}

// Input emits validated mouse events, virtual keys and Unicode UTF-16 keyboard events.
func (s *WinSession) Input(ctx context.Context, a *v1.DesktopAction) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := ctx.Err(); e != nil {
		return e
	}
	move := func(x, y int32) error {
		screen, _, e := s.API.Screen()
		if e != nil {
			return e
		}
		if screen.Width < 2 || screen.Height < 2 {
			return errors.New("invalid Windows screen size")
		}
		return s.API.Send([]WinInput{{X: int32(int64(x) * 65535 / int64(screen.Width-1)), Y: int32(int64(y) * 65535 / int64(screen.Height-1)), Flags: 0x8001}})
	}
	if a.X != nil {
		if e := move(*a.X, *a.Y); e != nil {
			return e
		}
	}
	down, up := uint32(2), uint32(4)
	if a.Button == "right" {
		down, up = 8, 16
	}
	if a.Button == "middle" {
		down, up = 32, 64
	}
	for _, mod := range a.Modifiers {
		if e := s.press(mod, false); e != nil {
			return e
		}
	}
	defer func() {
		for _, mod := range a.Modifiers {
			_ = s.press(mod, true)
		}
	}()
	switch a.Type {
	case "move":
		return nil
	case "click":
		for range max(a.Count, 1) {
			if e := s.API.Send([]WinInput{{Flags: down}, {Flags: up}}); e != nil {
				return e
			}
		}
		return nil
	case "mouse_down":
		return s.API.Send([]WinInput{{Flags: down}})
	case "mouse_up":
		return s.API.Send([]WinInput{{Flags: up}})
	case "drag":
		if e := move(a.Path[0].X, a.Path[0].Y); e != nil {
			return e
		}
		if e := s.API.Send([]WinInput{{Flags: down}}); e != nil {
			return e
		}
		defer func() { _ = s.API.Send([]WinInput{{Flags: up}}) }()
		for _, p := range a.Path[1:] {
			if e := move(p.X, p.Y); e != nil {
				return e
			}
			if e := pause(ctx, 10*time.Millisecond); e != nil {
				return e
			}
		}
		return nil
	case "scroll":
		var in []WinInput
		if a.Dy != 0 {
			in = append(in, WinInput{Data: uint32(-a.Dy), Flags: 0x800})
		}
		if a.Dx != 0 {
			in = append(in, WinInput{Data: uint32(a.Dx), Flags: 0x1000})
		}
		if len(in) == 0 {
			return nil
		}
		return s.API.Send(in)
	case "key_down":
		return s.press(a.Key, false)
	case "key_up":
		return s.press(a.Key, true)
	case "key":
		var held []string
		defer func() {
			for i := len(held) - 1; i >= 0; i-- {
				_ = s.press(held[i], true)
			}
		}()
		for _, key := range a.Keys {
			if e := s.press(key, false); e != nil {
				return e
			}
			held = append(held, key)
		}
		return nil
	case "type":
		delay := uint32(5)
		if a.DelayMs != nil {
			delay = *a.DelayMs
		}
		for _, r := range a.Text {
			for _, unit := range utf16.Encode([]rune{r}) {
				if e := s.API.Send([]WinInput{{Type: 1, Scan: unit, Flags: 4}, {Type: 1, Scan: unit, Flags: 6}}); e != nil {
					return e
				}
			}
			if e := pause(ctx, time.Duration(delay)*time.Millisecond); e != nil {
				return e
			}
		}
		return nil
	}
	return errors.New("unsupported Windows input")
}
