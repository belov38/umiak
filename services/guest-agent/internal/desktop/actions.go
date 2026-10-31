package desktop

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

func knownKey(key string) bool {
	if utf8.RuneCountInString(key) == 1 {
		r, _ := utf8.DecodeRuneInString(key)
		return unicode.IsPrint(r)
	}
	if strings.HasPrefix(key, "f") {
		n, e := strconv.Atoi(key[1:])
		if e == nil && n >= 1 && n <= 24 && key == fmt.Sprintf("f%d", n) {
			return true
		}
	}
	switch key {
	case "ctrl", "alt", "shift", "meta", "enter", "tab", "escape", "backspace", "delete", "insert", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "capslock", "printscreen", "menu":
		return true
	}
	return false
}

// Validate inline captures before input so rejected batches have no effects.
func validateScreenshot(q *v1.DesktopScreenshotRequest, screen *v1.DesktopSize) error {
	if q.Format != "" && q.Format != "png" && q.Format != "jpeg" || q.Quality > 100 {
		return failure(connect.CodeInvalidArgument, "invalid_argument")
	}
	if r := q.Region; r != nil {
		if r.X < 0 || r.Y < 0 || r.Width == 0 || r.Height == 0 || uint64(r.X)+uint64(r.Width) > uint64(screen.Width) || uint64(r.Y)+uint64(r.Height) > uint64(screen.Height) {
			return failure(connect.CodeInvalidArgument, "invalid_argument")
		}
	}
	return nil
}

func actionFailure(code connect.Code, detail string, index int, completed uint32, reason string) error {
	err := errs.Newf(code, detail, "action %d: %s; completed %d", index, reason, completed)
	d, e := connect.NewErrorDetail(&v1.DesktopActionFailure{Index: uint32(index), Completed: completed, Reason: reason})
	if e == nil {
		err.AddDetail(d)
	}
	return err
}
func validateActions(req *v1.DesktopActRequest, screen *v1.DesktopSize) ([]*v1.DesktopAction, error) {
	if len(req.Actions) == 0 || len(req.Actions) > 100 {
		return nil, failure(connect.CodeInvalidArgument, "invalid_action")
	}
	space := req.CoordinateSpace
	if space == nil {
		space = screen
	}
	if space.Width == 0 || space.Height == 0 {
		return nil, failure(connect.CodeInvalidArgument, "invalid_action")
	}
	var duration uint64
	out := make([]*v1.DesktopAction, len(req.Actions))
	for i, raw := range req.Actions {
		bad := func(reason string) ([]*v1.DesktopAction, error) {
			return nil, actionFailure(connect.CodeInvalidArgument, "invalid_action", i, 0, reason)
		}
		if raw == nil {
			return bad("missing action")
		}
		a := proto.Clone(raw).(*v1.DesktopAction)
		point := func(x, y int32) (int32, int32, bool) {
			if x < 0 || y < 0 || uint32(x) >= space.Width || uint32(y) >= space.Height {
				return 0, 0, false
			}
			return int32(uint64(x) * uint64(screen.Width) / uint64(space.Width)), int32(uint64(y) * uint64(screen.Height) / uint64(space.Height)), true
		}
		if (a.X == nil) != (a.Y == nil) {
			return bad("x and y must be supplied together")
		}
		if a.X != nil {
			x, y, ok := point(*a.X, *a.Y)
			if !ok {
				return bad("coordinates outside screen")
			}
			a.X, a.Y = &x, &y
		}
		if a.Button != "" && a.Button != "left" && a.Button != "right" && a.Button != "middle" {
			return bad("invalid button")
		}
		if a.Count > 3 {
			return bad("click count exceeds 3")
		}
		for _, mod := range a.Modifiers {
			if mod != "ctrl" && mod != "alt" && mod != "shift" && mod != "meta" {
				return bad("invalid modifier")
			}
		}
		switch a.Type {
		case "move":
			if a.X == nil {
				return bad("move requires coordinates")
			}
		case "click", "mouse_down", "mouse_up", "scroll":
		case "drag":
			if len(a.Path) < 2 || len(a.Path) > 1000 {
				return bad("drag requires 2..1000 points")
			}
			for _, p := range a.Path {
				if p == nil {
					return bad("missing point")
				}
				x, y, ok := point(p.X, p.Y)
				if !ok {
					return bad("drag outside screen")
				}
				p.X, p.Y = x, y
			}
		case "key":
			if len(a.Keys) == 0 || len(a.Keys) > 16 {
				return bad("invalid chord")
			}
			for _, k := range a.Keys {
				if !knownKey(k) {
					return bad("unknown key")
				}
			}
		case "key_down", "key_up":
			if !knownKey(a.Key) {
				return bad("unknown key")
			}
		case "type":
			if !utf8.ValidString(a.Text) || utf8.RuneCountInString(a.Text) > 10000 {
				return bad("text exceeds 10000 characters")
			}
			delay := uint32(5)
			if a.DelayMs != nil {
				delay = *a.DelayMs
			}
			if delay > 100 {
				return bad("delay exceeds 100ms")
			}
			duration += uint64(utf8.RuneCountInString(a.Text)) * uint64(delay)
		case "wait":
			if a.Ms > 10000 {
				return bad("wait exceeds 10000ms")
			}
			duration += uint64(a.Ms)
		default:
			return bad("unknown action type")
		}
		if duration > 60000 {
			return bad("batch exceeds 60s")
		}
		out[i] = a
	}
	return out, nil
}
