package process

import (
	"testing"
	"time"
)

func TestDirWatcherAfterClose(t *testing.T) {
	dir := t.TempDir()
	d, err := newDirWatcher(func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if !d.add(dir) {
		t.Fatal("add before close failed")
	}
	d.close()
	done := make(chan bool)
	go func() {
		d.remove(dir)
		done <- d.add(dir)
	}()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("add after close reported a watch")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("remove or add after close blocked")
	}
}
