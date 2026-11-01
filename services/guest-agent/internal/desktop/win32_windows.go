package desktop

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

var user32 = windows.NewLazySystemDLL("user32.dll")
var gdi32 = windows.NewLazySystemDLL("gdi32.dll")
var kernel32 = windows.NewLazySystemDLL("kernel32.dll")

func call(dll *windows.LazyDLL, name string, args ...uintptr) (uintptr, error) {
	r, _, e := dll.NewProc(name).Call(args...)
	if r == 0 {
		if errors.Is(e, windows.ERROR_SUCCESS) {
			e = errors.New("Win32 call failed")
		}
		return 0, fmt.Errorf("%s: %w", name, e)
	}
	return r, nil
}

type win32Desktop struct {
	window uintptr
	cancel context.CancelFunc
	done   chan struct{}
}

func newWin32Desktop(ctx context.Context) (*win32Desktop, error) {
	ctx, cancel := context.WithCancel(ctx)
	s := &win32Desktop{cancel: cancel, done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(s.done)
		_, _, _ = kernel32.NewProc("FreeConsole").Call()
		_, _, _ = user32.NewProc("SetProcessDpiAwarenessContext").Call(^uintptr(3))
		// Request the product display size; an unsupported adapter is detected by live verify.
		mode := make([]byte, 220)
		binary.LittleEndian.PutUint16(mode[68:], 220)
		binary.LittleEndian.PutUint32(mode[72:], 0x180000)
		binary.LittleEndian.PutUint32(mode[172:], 1920)
		binary.LittleEndian.PutUint32(mode[176:], 1080)
		_, _, _ = user32.NewProc("ChangeDisplaySettingsExW").Call(0, uintptr(unsafe.Pointer(&mode[0])), 0, 0, 0)
		class, _ := windows.UTF16PtrFromString("STATIC")
		name, _ := windows.UTF16PtrFromString("sbx-session clipboard")
		window, e := call(user32, "CreateWindowExW", 0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(name)), 0, 0, 0, 0, 0, ^uintptr(2), 0, 0, 0)
		if e != nil {
			ready <- e
			return
		}
		s.window = window
		ready <- nil
		defer func() { _, _, _ = user32.NewProc("DestroyWindow").Call(window) }()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		var msg [48]byte
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				for {
					ok, _, _ := user32.NewProc("PeekMessageW").Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0, 1)
					if ok == 0 {
						break
					}
					_, _, _ = user32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&msg[0])))
					_, _, _ = user32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&msg[0])))
				}
			}
		}
	}()
	if e := <-ready; e != nil {
		cancel()
		return nil, e
	}
	return s, nil
}
func (s *win32Desktop) Close() error { s.cancel(); <-s.done; return nil }
func (s *win32Desktop) Screen() (*v1.DesktopSize, *v1.DesktopPoint, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	desktop, e := call(user32, "OpenInputDesktop", 0, 0, 1)
	if e != nil {
		return nil, nil, e
	}
	defer func() { _, _, _ = user32.NewProc("CloseDesktop").Call(desktop) }()
	var name [128]uint16
	var needed uint32
	if _, e = call(user32, "GetUserObjectInformationW", desktop, 2, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)*2), uintptr(unsafe.Pointer(&needed))); e != nil {
		return nil, nil, e
	}
	if windows.UTF16ToString(name[:]) != "Default" {
		return nil, nil, errors.New("input desktop is locked")
	}
	w, _, _ := user32.NewProc("GetSystemMetrics").Call(0)
	h, _, _ := user32.NewProc("GetSystemMetrics").Call(1)
	var point struct{ X, Y int32 }
	if _, e = call(user32, "GetCursorPos", uintptr(unsafe.Pointer(&point))); e != nil {
		return nil, nil, e
	}
	if w == 0 || h == 0 || w > 16384 || h > 16384 {
		return nil, nil, errors.New("invalid native screen size")
	}
	return &v1.DesktopSize{Width: uint32(w), Height: uint32(h)}, &v1.DesktopPoint{X: point.X, Y: point.Y}, nil
}
func (s *win32Desktop) Capture(cursor bool) (image.Image, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	size, _, e := s.Screen()
	if e != nil {
		return nil, e
	}
	w, h := int(size.Width), int(size.Height)
	dc, e := call(user32, "GetDC", 0)
	if e != nil {
		return nil, e
	}
	defer func() { _, _, _ = user32.NewProc("ReleaseDC").Call(0, dc) }()
	mem, e := call(gdi32, "CreateCompatibleDC", dc)
	if e != nil {
		return nil, e
	}
	defer func() { _, _, _ = gdi32.NewProc("DeleteDC").Call(mem) }()
	bitmap, e := call(gdi32, "CreateCompatibleBitmap", dc, uintptr(w), uintptr(h))
	if e != nil {
		return nil, e
	}
	defer func() { _, _, _ = gdi32.NewProc("DeleteObject").Call(bitmap) }()
	old, e := call(gdi32, "SelectObject", mem, bitmap)
	if e != nil {
		return nil, e
	}
	defer func() { _, _, _ = gdi32.NewProc("SelectObject").Call(mem, old) }()
	if _, e = call(gdi32, "BitBlt", mem, 0, 0, uintptr(w), uintptr(h), dc, 0, 0, 0x40cc0020); e != nil {
		return nil, e
	}
	if cursor {
		var ci struct {
			Size, Flags uint32
			Handle      uintptr
			X, Y        int32
		}
		ci.Size = uint32(unsafe.Sizeof(ci))
		if _, e = call(user32, "GetCursorInfo", uintptr(unsafe.Pointer(&ci))); e != nil {
			return nil, e
		}
		if ci.Flags&1 != 0 {
			var icon struct {
				Icon        int32
				Xhot, Yhot  uint32
				Mask, Color uintptr
			}
			if _, e = call(user32, "GetIconInfo", ci.Handle, uintptr(unsafe.Pointer(&icon))); e != nil {
				return nil, e
			}
			_, _, _ = user32.NewProc("DrawIconEx").Call(mem, uintptr(int64(ci.X)-int64(icon.Xhot)), uintptr(int64(ci.Y)-int64(icon.Yhot)), ci.Handle, 0, 0, 0, 0, 3)
			if icon.Mask != 0 {
				_, _, _ = gdi32.NewProc("DeleteObject").Call(icon.Mask)
			}
			if icon.Color != 0 {
				_, _, _ = gdi32.NewProc("DeleteObject").Call(icon.Color)
			}
		}
	}
	// GetDIBits must be called with the bitmap deselected from the memory DC.
	_, _, _ = gdi32.NewProc("SelectObject").Call(mem, old)
	var bmi [40]byte
	binary.LittleEndian.PutUint32(bmi[:], 40)
	binary.LittleEndian.PutUint32(bmi[4:], uint32(w))
	binary.LittleEndian.PutUint32(bmi[8:], uint32(-int32(h)))
	binary.LittleEndian.PutUint16(bmi[12:], 1)
	binary.LittleEndian.PutUint16(bmi[14:], 32)
	pixels := make([]byte, w*h*4)
	n, e := call(gdi32, "GetDIBits", dc, bitmap, 0, uintptr(h), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&bmi[0])), 0)
	if e != nil || int(n) != h {
		return nil, errors.New("incomplete GDI capture")
	}
	return decodeXImage(pixels, w, h, 32, false, 0xff0000, 0xff00, 0xff)
}

// sendInputRetryWindow bounds how long a blocked SendInput is retried. Windows
// refuses input (0 inserted, ERROR_ACCESS_DENIED) while the input desktop is
// briefly not the user's Default desktop, for example during the logon
// transition of a freshly booted fork. An action waits at most this long
// before action_failed.
const sendInputRetryWindow = 2 * time.Second

func (s *win32Desktop) Send(inputs []WinInput) error {
	if len(inputs) == 0 {
		return nil
	}
	send := func(batch []WinInput) (int, error) {
		wire := encodeWinInputs(batch)
		n, _, e := user32.NewProc("SendInput").Call(uintptr(len(batch)), uintptr(unsafe.Pointer(&wire[0])), 40)
		return int(n), e
	}
	blocked := func(e error) error {
		return fmt.Errorf("windows input was blocked (input desktop %q): %w", inputDesktopName(), e)
	}
	return sendInputs(inputs, send, blocked, time.Sleep, sendInputRetryWindow)
}

// inputDesktopName names the desktop that receives input now ("Default" for
// the user's desktop, "Winlogon" for the secure desktop), for diagnostics.
func inputDesktopName() string {
	desktop, e := call(user32, "OpenInputDesktop", 0, 0, 1)
	if e != nil {
		return "unavailable: " + e.Error()
	}
	defer func() { _, _, _ = user32.NewProc("CloseDesktop").Call(desktop) }()
	var name [128]uint16
	var needed uint32
	if _, e = call(user32, "GetUserObjectInformationW", desktop, 2, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)*2), uintptr(unsafe.Pointer(&needed))); e != nil {
		return "unknown"
	}
	return windows.UTF16ToString(name[:])
}
func (s *win32Desktop) Key(key string) (uint16, byte, error) {
	names := map[string]uint16{"ctrl": 0x11, "alt": 0x12, "shift": 0x10, "meta": 0x5b, "enter": 13, "tab": 9, "escape": 27, "backspace": 8, "delete": 46, "insert": 45, "space": 32, "up": 38, "down": 40, "left": 37, "right": 39, "home": 36, "end": 35, "pageup": 33, "pagedown": 34, "capslock": 20, "printscreen": 44, "menu": 0x5d}
	if vk := names[key]; vk != 0 {
		return vk, 0, nil
	}
	if strings.HasPrefix(key, "f") {
		n, e := strconv.Atoi(key[1:])
		if e == nil && n >= 1 && n <= 24 {
			return uint16(0x6f + n), 0, nil
		}
	}
	r, n := utf8.DecodeRuneInString(key)
	if n != len(key) || r > 0xffff {
		return 0, 0, errors.New("key has no virtual-key mapping")
	}
	v, _, _ := user32.NewProc("VkKeyScanW").Call(uintptr(r))
	if uint16(v) == 0xffff {
		return 0, 0, errors.New("key has no virtual-key mapping")
	}
	return uint16(v) & 255, byte(v >> 8), nil
}
func (s *win32Desktop) openClipboard() error {
	for range 100 {
		if _, e := call(user32, "OpenClipboard", s.window); e == nil {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("clipboard is busy")
}
func (s *win32Desktop) GetClipboard() (string, bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if e := s.openClipboard(); e != nil {
		return "", false, e
	}
	defer func() { _, _, _ = user32.NewProc("CloseClipboard").Call() }()
	ok, _, _ := user32.NewProc("IsClipboardFormatAvailable").Call(13)
	if ok == 0 {
		return "", false, nil
	}
	h, e := call(user32, "GetClipboardData", 13)
	if e != nil {
		return "", false, e
	}
	size, e := call(kernel32, "GlobalSize", h)
	if e != nil || size > 2<<20+2 {
		return "", false, errors.New("clipboard exceeds limit")
	}
	p, e := call(kernel32, "GlobalLock", h)
	if e != nil {
		return "", false, e
	}
	defer func() { _, _, _ = kernel32.NewProc("GlobalUnlock").Call(h) }()
	data := make([]uint16, (size+1)/2)
	_, _, _ = kernel32.NewProc("RtlMoveMemory").Call(uintptr(unsafe.Pointer(&data[0])), p, size)
	return windows.UTF16ToString(data), true, nil
}
func (s *win32Desktop) SetClipboard(text string) error {
	if strings.ContainsRune(text, 0) {
		return errors.New("CF_UNICODETEXT cannot contain NUL")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if e := s.openClipboard(); e != nil {
		return e
	}
	defer func() { _, _, _ = user32.NewProc("CloseClipboard").Call() }()
	if _, e := call(user32, "EmptyClipboard"); e != nil {
		return e
	}
	data := append(utf16.Encode([]rune(text)), 0)
	size := uintptr(len(data) * 2)
	h, e := call(kernel32, "GlobalAlloc", 0x42, size)
	if e != nil {
		return e
	}
	owned := false
	defer func() {
		if !owned {
			_, _, _ = kernel32.NewProc("GlobalFree").Call(h)
		}
	}()
	p, e := call(kernel32, "GlobalLock", h)
	if e != nil {
		return e
	}
	_, _, _ = kernel32.NewProc("RtlMoveMemory").Call(p, uintptr(unsafe.Pointer(&data[0])), size)
	_, _, _ = kernel32.NewProc("GlobalUnlock").Call(h)
	if _, e = call(user32, "SetClipboardData", 13, h); e != nil {
		return e
	}
	owned = true
	return nil
}
