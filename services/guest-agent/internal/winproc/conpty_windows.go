package winproc

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sync"

	"golang.org/x/sys/windows"
)

// PseudoConsole is a ConPTY. In feeds the console input; Out yields its
// output (VT sequences) and reaches EOF after Close once the console host
// has flushed. Out must be drained while the console lives: a full output
// pipe blocks the console and Close.
type PseudoConsole struct {
	In  io.WriteCloser
	Out io.ReadCloser

	mu  sync.Mutex
	hpc windows.Handle
}

// NewPseudoConsole creates a pseudo console of cols x rows.
func NewPseudoConsole(cols, rows uint16) (*PseudoConsole, error) {
	size, err := coord(cols, rows)
	if err != nil {
		return nil, err
	}
	// inR/outW go to the console host, which keeps its own duplicates.
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, fmt.Errorf("winproc: pty input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		_ = windows.CloseHandle(inR)
		_ = windows.CloseHandle(inW)
		return nil, fmt.Errorf("winproc: pty output pipe: %w", err)
	}
	var hpc windows.Handle
	err = windows.CreatePseudoConsole(size, inR, outW, 0, &hpc)
	_ = windows.CloseHandle(inR)
	_ = windows.CloseHandle(outW)
	if err != nil {
		_ = windows.CloseHandle(inW)
		_ = windows.CloseHandle(outR)
		return nil, fmt.Errorf("winproc: CreatePseudoConsole: %w", err)
	}
	return &PseudoConsole{
		In:  os.NewFile(uintptr(inW), "pty-in"),
		Out: os.NewFile(uintptr(outR), "pty-out"),
		hpc: hpc,
	}, nil
}

func coord(cols, rows uint16) (windows.Coord, error) {
	if cols == 0 || rows == 0 || cols > math.MaxInt16 || rows > math.MaxInt16 {
		return windows.Coord{}, fmt.Errorf("winproc: bad pty size %dx%d", cols, rows)
	}
	return windows.Coord{X: int16(cols), Y: int16(rows)}, nil //nolint:gosec // checked above
}

// Handle returns the HPCON for StartOptions.PseudoConsole; 0 after Close.
func (c *PseudoConsole) Handle() windows.Handle {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hpc
}

// Resize changes the console size.
func (c *PseudoConsole) Resize(cols, rows uint16) error {
	size, err := coord(cols, rows)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hpc == 0 {
		return errors.New("winproc: pseudo console is closed")
	}
	if err := windows.ResizePseudoConsole(c.hpc, size); err != nil {
		return fmt.Errorf("winproc: ResizePseudoConsole: %w", err)
	}
	return nil
}

// Close closes the console (its processes get CTRL_CLOSE_EVENT) and In.
// Out stays open: read it to EOF, then close it.
func (c *PseudoConsole) Close() error {
	c.mu.Lock()
	hpc := c.hpc
	c.hpc = 0
	c.mu.Unlock()
	if hpc == 0 {
		return nil
	}
	// It can block until the host flushed its output, so not under mu.
	windows.ClosePseudoConsole(hpc)
	_ = c.In.Close()
	return nil
}
