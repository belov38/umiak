package desktop

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"math/bits"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	v1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
)

// X11Session runs inside the autologin session; Xauthority never leaves it.
type X11Session struct {
	c                                        *xgb.Conn
	root                                     xproto.Window
	window                                   xproto.Window
	setup                                    *xproto.SetupInfo
	clipboard, utf8, targets, property, incr xproto.Atom
	op                                       sync.Mutex
	textMu                                   sync.Mutex
	text                                     string
	notify                                   chan xgb.Event
	done                                     chan struct{}
}

// NewX11Session connects to the session display using its Xauthority.
func NewX11Session() (*X11Session, error) {
	c, e := xgb.NewConn()
	if e != nil {
		return nil, e
	}
	fail := func(e error) (*X11Session, error) { c.Close(); return nil, e }
	if e = xtest.Init(c); e != nil {
		return fail(e)
	}
	if e = initXFixes(c); e != nil {
		return fail(e)
	}
	s := &X11Session{c: c, setup: xproto.Setup(c), notify: make(chan xgb.Event, 64), done: make(chan struct{})}
	screen := s.setup.DefaultScreen(c)
	s.root = screen.Root
	s.window, e = xproto.NewWindowId(c)
	if e != nil {
		return fail(e)
	}
	if e = xproto.CreateWindowChecked(c, 0, s.window, s.root, 0, 0, 1, 1, 0, xproto.WindowClassInputOutput, 0, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange}).Check(); e != nil {
		return fail(e)
	}
	for name, dest := range map[string]*xproto.Atom{"CLIPBOARD": &s.clipboard, "UTF8_STRING": &s.utf8, "TARGETS": &s.targets, "UMIAK_CLIPBOARD": &s.property, "INCR": &s.incr} {
		r, err := xproto.InternAtom(c, false, uint16(len(name)), name).Reply()
		if err != nil {
			return fail(err)
		}
		*dest = r.Atom
	}
	go s.events()
	return s, nil
}

// Close releases the desktop connection.
func (s *X11Session) Close() error { s.c.Close(); return nil }

// Done closes when Xorg disconnects, so systemd can restart the helper.
func (s *X11Session) Done() <-chan struct{} { return s.done }

// State returns the live screen dimensions and pointer.
func (s *X11Session) State(ctx context.Context) (*v1.DesktopSize, *v1.DesktopPoint, error) {
	if e := ctx.Err(); e != nil {
		return nil, nil, e
	}
	g, e := xproto.GetGeometry(s.c, xproto.Drawable(s.root)).Reply()
	if e != nil {
		return nil, nil, e
	}
	p, e := xproto.QueryPointer(s.c, s.root).Reply()
	if e != nil {
		return nil, nil, e
	}
	if g.Width > 32767 || g.Height > 32767 {
		return nil, nil, errors.New("X11 screen exceeds input coordinate range")
	}
	return &v1.DesktopSize{Width: uint32(g.Width), Height: uint32(g.Height)}, &v1.DesktopPoint{X: int32(p.RootX), Y: int32(p.RootY)}, nil
}
func decodeXImage(data []byte, w, h, bpp int, big bool, red, green, blue uint32) (*image.RGBA, error) {
	stride := ((w*bpp + 31) / 32) * 4
	if w <= 0 || h <= 0 || bpp != 32 || len(data) < stride*h {
		return nil, errors.New("unsupported or truncated X11 capture")
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var order binary.ByteOrder = binary.LittleEndian
	if big {
		order = binary.BigEndian
	}
	component := func(pixel, mask uint32) uint8 {
		if mask == 0 {
			return 0
		}
		v := mask >> bits.TrailingZeros32(mask)
		return uint8(((pixel & mask) >> bits.TrailingZeros32(mask)) * 255 / v)
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			p := order.Uint32(data[y*stride+x*4:])
			img.SetRGBA(x, y, color.RGBA{component(p, red), component(p, green), component(p, blue), 255})
		}
	}
	return img, nil
}

// Capture captures the desktop independently of video streaming.
func (s *X11Session) Capture(ctx context.Context, cursor bool) (image.Image, error) {
	screen, _, e := s.State(ctx)
	if e != nil {
		return nil, e
	}
	r, e := xproto.GetImage(s.c, xproto.ImageFormatZPixmap, xproto.Drawable(s.root), 0, 0, uint16(screen.Width), uint16(screen.Height), 0xffffffff).Reply()
	if e != nil {
		return nil, e
	}
	var bpp int
	for _, f := range s.setup.PixmapFormats {
		if f.Depth == r.Depth {
			bpp = int(f.BitsPerPixel)
		}
	}
	var visual xproto.VisualInfo
	for _, d := range s.setup.DefaultScreen(s.c).AllowedDepths {
		for _, v := range d.Visuals {
			if v.VisualId == r.Visual {
				visual = v
			}
		}
	}
	img, e := decodeXImage(r.Data, int(screen.Width), int(screen.Height), bpp, s.setup.ImageByteOrder == xproto.ImageOrderMSBFirst, visual.RedMask, visual.GreenMask, visual.BlueMask)
	if e != nil {
		return nil, e
	}
	if cursor {
		p, err := xfixes.GetCursorImage(s.c).Reply()
		if err != nil {
			return nil, err
		}
		ci := image.NewRGBA(image.Rect(0, 0, int(p.Width), int(p.Height)))
		for i, pixel := range p.CursorImage {
			ci.SetRGBA(i%int(p.Width), i/int(p.Width), color.RGBA{uint8(pixel >> 16), uint8(pixel >> 8), uint8(pixel), uint8(pixel >> 24)})
		}
		at := image.Pt(int(p.X)-int(p.Xhot), int(p.Y)-int(p.Yhot))
		draw.Draw(img, ci.Bounds().Add(at), ci, image.Point{}, draw.Over)
	}
	return img, nil
}
func keySymbol(key string) uint32 {
	names := map[string]uint32{"ctrl": 0xffe3, "alt": 0xffe9, "shift": 0xffe1, "meta": 0xffeb, "enter": 0xff0d, "tab": 0xff09, "escape": 0xff1b, "backspace": 0xff08, "delete": 0xffff, "insert": 0xff63, "space": 32, "up": 0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53, "home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56, "capslock": 0xffe5, "printscreen": 0xff61, "menu": 0xff67}
	if v := names[key]; v != 0 {
		return v
	}
	if strings.HasPrefix(key, "f") {
		if n, e := strconv.Atoi(key[1:]); e == nil && n >= 1 && n <= 24 {
			return uint32(0xffbd + n)
		}
	}
	if utf8.RuneCountInString(key) == 1 {
		r, _ := utf8.DecodeRuneInString(key)
		if r == '\n' {
			return 0xff0d
		}
		if r == '\t' {
			return 0xff09
		}
		if r <= 255 {
			return uint32(r)
		}
		return 0x1000000 | uint32(r)
	}
	return 0
}
func (s *X11Session) fake(kind, detail byte, x, y int32) error {
	return xtest.FakeInputChecked(s.c, kind, detail, 0, s.root, int16(x), int16(y), 0).Check()
}
func (s *X11Session) keycode(key string) (byte, bool, error) {
	sym := keySymbol(key)
	r, e := xproto.GetKeyboardMapping(s.c, s.setup.MinKeycode, byte(s.setup.MaxKeycode-s.setup.MinKeycode+1)).Reply()
	if e != nil {
		return 0, false, e
	}
	for i, k := range r.Keysyms {
		if uint32(k) == sym && i%int(r.KeysymsPerKeycode) < 2 {
			return byte(s.setup.MinKeycode) + byte(i/int(r.KeysymsPerKeycode)), i%int(r.KeysymsPerKeycode) == 1, nil
		}
	}
	return 0, false, fmt.Errorf("key %q not present in X11 keymap", key)
}
func (s *X11Session) chord(keys []string) error {
	var held []byte
	defer func() {
		for i := len(held) - 1; i >= 0; i-- {
			_ = s.fake(xproto.KeyRelease, held[i], 0, 0)
		}
	}()
	for _, key := range keys {
		code, shift, e := s.keycode(key)
		if e != nil {
			return e
		}
		if shift {
			sc, _, e := s.keycode("shift")
			if e != nil {
				return e
			}
			if e = s.fake(xproto.KeyPress, sc, 0, 0); e != nil {
				return e
			}
			held = append(held, sc)
		}
		if e = s.fake(xproto.KeyPress, code, 0, 0); e != nil {
			return e
		}
		held = append(held, code)
	}
	return nil
}
func pause(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Input dispatches a validated input action.
func (s *X11Session) Input(ctx context.Context, a *v1.DesktopAction) error {
	s.op.Lock()
	defer s.op.Unlock()
	if e := ctx.Err(); e != nil {
		return e
	}
	button := byte(1)
	if a.Button == "middle" {
		button = 2
	}
	if a.Button == "right" {
		button = 3
	}
	if a.X != nil {
		if e := s.fake(xproto.MotionNotify, 0, *a.X, *a.Y); e != nil {
			return e
		}
	}
	var mods []byte
	defer func() {
		for _, m := range mods {
			_ = s.fake(xproto.KeyRelease, m, 0, 0)
		}
	}()
	for _, m := range a.Modifiers {
		c, _, e := s.keycode(m)
		if e != nil {
			return e
		}
		if e = s.fake(xproto.KeyPress, c, 0, 0); e != nil {
			return e
		}
		mods = append(mods, c)
	}
	click := func(b byte) error {
		if e := s.fake(xproto.ButtonPress, b, 0, 0); e != nil {
			return e
		}
		return s.fake(xproto.ButtonRelease, b, 0, 0)
	}
	switch a.Type {
	case "move":
		return nil
	case "click":
		for range max(a.Count, 1) {
			if e := click(button); e != nil {
				return e
			}
		}
		return nil
	case "mouse_down":
		return s.fake(xproto.ButtonPress, button, 0, 0)
	case "mouse_up":
		return s.fake(xproto.ButtonRelease, button, 0, 0)
	case "key":
		return s.chord(a.Keys)
	case "key_down", "key_up":
		c, _, e := s.keycode(a.Key)
		if e != nil {
			return e
		}
		kind := byte(xproto.KeyPress)
		if a.Type == "key_up" {
			kind = xproto.KeyRelease
		}
		return s.fake(kind, c, 0, 0)
	case "drag":
		p := a.Path[0]
		if e := s.fake(xproto.MotionNotify, 0, p.X, p.Y); e != nil {
			return e
		}
		if e := s.fake(xproto.ButtonPress, button, 0, 0); e != nil {
			return e
		}
		defer func() { _ = s.fake(xproto.ButtonRelease, button, 0, 0) }()
		for _, p := range a.Path[1:] {
			if e := s.fake(xproto.MotionNotify, 0, p.X, p.Y); e != nil {
				return e
			}
			if e := pause(ctx, 10*time.Millisecond); e != nil {
				return e
			}
		}
		return nil
	case "scroll":
		for axis, n := range []int32{a.Dy, a.Dx} {
			b := byte(5 + 2*axis)
			v := int64(n)
			if v < 0 {
				v = -v
				b--
			}
			for range (v + 119) / 120 {
				if e := ctx.Err(); e != nil {
					return e
				}
				if e := click(b); e != nil {
					return e
				}
			}
		}
		return nil
	case "type":
		const capacity = 64
		first := s.setup.MaxKeycode - capacity + 1
		original, e := xproto.GetKeyboardMapping(s.c, first, capacity).Reply()
		if e != nil {
			return e
		}
		defer func() {
			_ = xproto.ChangeKeyboardMappingChecked(s.c, capacity, first, original.KeysymsPerKeycode, original.Keysyms).Check()
		}()
		delay := uint32(5)
		if a.DelayMs != nil {
			delay = *a.DelayMs
		}
		for _, batch := range planTextBatches(a.Text, capacity) {
			syms := append([]xproto.Keysym(nil), original.Keysyms...)
			for i, sym := range batch.Symbols {
				for j := 0; j < int(original.KeysymsPerKeycode); j++ {
					syms[i*int(original.KeysymsPerKeycode)+j] = xproto.Keysym(sym)
				}
			}
			if e = xproto.ChangeKeyboardMappingChecked(s.c, capacity, first, original.KeysymsPerKeycode, syms).Check(); e != nil {
				return e
			}
			for _, index := range batch.Codes {
				code := byte(first) + byte(index)
				if e = s.fake(xproto.KeyPress, code, 0, 0); e != nil {
					return e
				}
				if e = s.fake(xproto.KeyRelease, code, 0, 0); e != nil {
					return e
				}
				if e = pause(ctx, time.Duration(delay)*time.Millisecond); e != nil {
					return e
				}
			}
			// Allow interactive clients to consume the batch before replacing it.
			if e = pause(ctx, 50*time.Millisecond); e != nil {
				return e
			}
		}
		return nil
	}
	return errors.New("unsupported X11 action")
}
func (s *X11Session) events() {
	defer close(s.done)
	type transfer struct {
		target xproto.Atom
		data   []byte
	}
	type transferKey struct {
		window   xproto.Window
		property xproto.Atom
	}
	transfers := map[transferKey]transfer{}
	for {
		event, e := s.c.WaitForEvent()
		if e != nil || event == nil {
			return
		}
		switch ev := event.(type) {
		case xproto.SelectionRequestEvent:
			prop := ev.Property
			if prop == 0 {
				prop = ev.Target
			}
			ok := false
			if ev.Selection == s.clipboard {
				switch ev.Target {
				case s.targets:
					data := make([]byte, 12)
					for i, a := range []xproto.Atom{s.targets, s.utf8, xproto.AtomString} {
						xgb.Put32(data[i*4:], uint32(a))
					}
					ok = xproto.ChangePropertyChecked(s.c, xproto.PropModeReplace, ev.Requestor, prop, xproto.AtomAtom, 32, 3, data).Check() == nil
				case s.utf8, xproto.AtomString:
					s.textMu.Lock()
					text := s.text
					s.textMu.Unlock()
					if len(text) > 64<<10 {
						data := make([]byte, 4)
						xgb.Put32(data, uint32(len(text)))
						ok = xproto.ChangeWindowAttributesChecked(s.c, ev.Requestor, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange}).Check() == nil && xproto.ChangePropertyChecked(s.c, xproto.PropModeReplace, ev.Requestor, prop, s.incr, 32, 1, data).Check() == nil
						if ok {
							transfers[transferKey{ev.Requestor, prop}] = transfer{ev.Target, []byte(text)}
						}
					} else {
						ok = xproto.ChangePropertyChecked(s.c, xproto.PropModeReplace, ev.Requestor, prop, ev.Target, 8, uint32(len(text)), []byte(text)).Check() == nil
					}
				}
			}
			if !ok {
				prop = 0
			}
			reply := xproto.SelectionNotifyEvent{Time: ev.Time, Requestor: ev.Requestor, Selection: ev.Selection, Target: ev.Target, Property: prop}
			_ = xproto.SendEventChecked(s.c, false, ev.Requestor, 0, string(reply.Bytes())).Check()
		case xproto.SelectionNotifyEvent:
			select {
			case s.notify <- ev:
			default:
			}
		case xproto.PropertyNotifyEvent:
			key := transferKey{ev.Window, ev.Atom}
			if tr, ok := transfers[key]; ok && ev.State == xproto.PropertyDelete {
				n := min(len(tr.data), 64<<10)
				err := xproto.ChangePropertyChecked(s.c, xproto.PropModeReplace, ev.Window, ev.Atom, tr.target, 8, uint32(n), tr.data[:n]).Check()
				if err != nil || n == 0 {
					delete(transfers, key)
				} else {
					tr.data = tr.data[n:]
					transfers[key] = tr
				}
			}
			if ev.Window == s.window && ev.Atom == s.property && ev.State == xproto.PropertyNewValue {
				select {
				case s.notify <- ev:
				default:
				}
			}
		}
	}
}

// ClipboardSet owns the interactive text selection.
func (s *X11Session) ClipboardSet(ctx context.Context, text string) error {
	s.op.Lock()
	defer s.op.Unlock()
	if e := ctx.Err(); e != nil {
		return e
	}
	s.textMu.Lock()
	s.text = text
	s.textMu.Unlock()
	return xproto.SetSelectionOwnerChecked(s.c, s.window, s.clipboard, xproto.TimeCurrentTime).Check()
}

// ClipboardGet reads the interactive text selection.
func (s *X11Session) ClipboardGet(ctx context.Context) (string, bool, error) {
	s.op.Lock()
	defer s.op.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	owner, e := xproto.GetSelectionOwner(s.c, s.clipboard).Reply()
	if e != nil {
		return "", false, e
	}
	if owner.Owner == 0 {
		return "", false, nil
	}
	if owner.Owner == s.window {
		s.textMu.Lock()
		defer s.textMu.Unlock()
		return s.text, true, nil
	}
	for len(s.notify) > 0 {
		<-s.notify
	}
	if e = xproto.ConvertSelectionChecked(s.c, s.window, s.clipboard, s.utf8, s.property, xproto.TimeCurrentTime).Check(); e != nil {
		return "", false, e
	}
	for {
		select {
		case <-ctx.Done():
			return "", false, ctx.Err()
		case ev := <-s.notify:
			if v, ok := ev.(xproto.SelectionNotifyEvent); ok {
				if v.Property == 0 {
					return "", false, nil
				}
				goto received
			}
		}
	}
received:
	p, e := xproto.GetProperty(s.c, true, s.window, s.property, xproto.GetPropertyTypeAny, 0, (1<<20)/4+1).Reply()
	if e != nil {
		return "", false, e
	}
	if p.Type != s.incr {
		if len(p.Value) > 1<<20 || p.BytesAfter > 0 {
			return "", false, errors.New("clipboard exceeds 1MiB")
		}
		return string(p.Value), p.Type != 0, nil
	}
	// INCR owners send chunks after each property deletion acknowledgement.
	var data []byte
	for {
		select {
		case <-ctx.Done():
			return "", false, ctx.Err()
		case ev := <-s.notify:
			if _, ok := ev.(xproto.PropertyNotifyEvent); !ok {
				continue
			}
			p, e = xproto.GetProperty(s.c, true, s.window, s.property, xproto.GetPropertyTypeAny, 0, (1<<20)/4+1).Reply()
			if e != nil {
				return "", false, e
			}
			if p.Type == 0 {
				continue
			}
			if len(p.Value) == 0 {
				return string(data), true, nil
			}
			data = append(data, p.Value...)
			if len(data) > 1<<20 || p.BytesAfter > 0 {
				return "", false, errors.New("clipboard exceeds 1MiB")
			}
		}
	}
}

func initXFixes(c *xgb.Conn) error {
	if err := xfixes.Init(c); err != nil {
		return err
	}
	version, err := xfixes.QueryVersion(c, 1, 0).Reply()
	if err != nil {
		return err
	}
	if version == nil || version.MajorVersion < 1 {
		return errors.New("XFixes cursor capture requires version 1")
	}
	return nil
}
