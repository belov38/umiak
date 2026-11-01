package desktop

import (
	"context"
	"encoding/binary"
	"errors"
	"image"
	"slices"
	"testing"
	"time"

	v1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
)

type fakeWinDesktop struct {
	inputs        []WinInput
	text          string
	sends, failAt int
}

func (*fakeWinDesktop) Screen() (*v1.DesktopSize, *v1.DesktopPoint, error) {
	return &v1.DesktopSize{Width: 1920, Height: 1080}, &v1.DesktopPoint{X: 5, Y: 7}, nil
}
func (*fakeWinDesktop) Capture(bool) (image.Image, error) {
	return image.NewRGBA(image.Rect(0, 0, 1920, 1080)), nil
}
func (f *fakeWinDesktop) Send(in []WinInput) error {
	f.sends++
	if f.sends == f.failAt {
		return errors.New("input blocked")
	}
	f.inputs = append(f.inputs, in...)
	return nil
}
func (*fakeWinDesktop) Key(string) (uint16, byte, error)      { return 65, 0, nil }
func (f *fakeWinDesktop) GetClipboard() (string, bool, error) { return f.text, true, nil }
func (f *fakeWinDesktop) SetClipboard(s string) error         { f.text = s; return nil }
func TestWindowsInputUTF16AndAbsoluteMouse(t *testing.T) {
	f := &fakeWinDesktop{}
	s := &WinSession{API: f}
	ctx := context.Background()
	if e := s.Input(ctx, &v1.DesktopAction{Type: "type", Text: "A😀", DelayMs: new(uint32)}); e != nil {
		t.Fatal(e)
	}
	if len(f.inputs) != 6 || f.inputs[2].Scan != 0xd83d || f.inputs[4].Scan != 0xde00 || f.inputs[5].Flags != 6 {
		t.Fatalf("UTF16 events %v", f.inputs)
	}
	x, y := int32(1919), int32(1079)
	if e := s.Input(ctx, &v1.DesktopAction{Type: "move", X: &x, Y: &y}); e != nil {
		t.Fatal(e)
	}
	last := f.inputs[len(f.inputs)-1]
	if last.X != 65535 || last.Y != 65535 || last.Flags != 0x8001 {
		t.Fatalf("absolute move %v", last)
	}
	wire := encodeWinInputs([]WinInput{{Type: 1, Key: 65, Flags: 2}})
	if len(wire) != 40 || binary.LittleEndian.Uint16(wire[8:]) != 65 || binary.LittleEndian.Uint32(wire[12:]) != 2 {
		t.Fatalf("INPUT ABI %x", wire)
	}
}

func TestWindowsModifierFailureReleasesPressedKeys(t *testing.T) {
	f := &fakeWinDesktop{failAt: 2}
	s := &WinSession{API: f}
	if e := s.Input(context.Background(), &v1.DesktopAction{Type: "click", Modifiers: []string{"ctrl", "alt"}}); e == nil {
		t.Fatal("lost input error")
	}
	if len(f.inputs) == 0 || f.inputs[len(f.inputs)-1].Flags != 2 {
		t.Fatalf("modifier remains held: %v", f.inputs)
	}
}

// TestSendInputsRetriesOnlyTheRefusedTail: a briefly blocked input desktop
// does not fail the action and no input is sent twice; a lasting block fails
// after the bounded window.
func TestSendInputsRetriesOnlyTheRefusedTail(t *testing.T) {
	in := []WinInput{{Key: 1}, {Key: 2}, {Key: 3}}
	var sent []uint16
	answers := []int{0, 1, 0, 2}
	send := func(batch []WinInput) (int, error) {
		n := answers[0]
		answers = answers[1:]
		for _, x := range batch[:n] {
			sent = append(sent, x.Key)
		}
		return n, errors.New("access denied")
	}
	var slept time.Duration
	sleep := func(d time.Duration) { slept += d }
	if err := sendInputs(in, send, func(e error) error { return e }, sleep, time.Second); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(sent, []uint16{1, 2, 3}) || slept != 3*sendInputRetryDelay {
		t.Fatalf("sent %v after %v", sent, slept)
	}
	never := func([]WinInput) (int, error) { return 0, errors.New("access denied") }
	slept = 0
	err := sendInputs(in, never, func(e error) error { return errors.New("blocked: " + e.Error()) }, sleep, 200*time.Millisecond)
	if err == nil || err.Error() != "blocked: access denied" || slept != 200*time.Millisecond {
		t.Fatalf("lasting block: err=%v slept=%v", err, slept)
	}
}
