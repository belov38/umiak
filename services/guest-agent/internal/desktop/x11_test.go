package desktop

import (
	"image/color"
	"testing"
)

// TestX11PixelOrderAndUnicode implements the desktop adapter boundary.
func TestX11PixelOrderAndUnicode(t *testing.T) {
	img, e := decodeXImage([]byte{0x33, 0x22, 0x11, 0, 0xcc, 0xbb, 0xaa, 0}, 2, 1, 32, false, 0xff0000, 0xff00, 0xff)
	if e != nil || img.RGBAAt(1, 0) != (color.RGBA{0xaa, 0xbb, 0xcc, 255}) {
		t.Fatalf("pixels %v %v", img, e)
	}
	if _, e = decodeXImage([]byte{0}, 2, 1, 32, false, 0xff0000, 0xff00, 0xff); e == nil {
		t.Fatal("accepted truncated capture")
	}
	if keySymbol("世") != 0x1004e16 || keySymbol("enter") != 0xff0d {
		t.Fatal("Unicode/special keysym")
	}
}
