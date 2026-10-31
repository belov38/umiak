package files

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

// Reconstruct a process crash after copy placement but before the source
// upload was removed. Only the durable intent and files survive.
func TestCopiedUploadRetryBeforeSourceRemoval(t *testing.T) {
	for _, placed := range []bool{true, false} {
		t.Run(map[bool]string{true: "our target", false: "unrelated equal content"}[placed], func(t *testing.T) {
			h := newHarness(t)
			wantStatus(t, h.do(http.MethodPut, "/files/uploads/copy", q("offset", "0"), strings.NewReader("content"), nil), http.StatusOK)
			rec, _, err := h.st.GetUpload("copy")
			if err != nil {
				t.Fatal(err)
			}
			stage := h.writeFile(".sbx-tmp-copy", []byte("content"), 0o644)
			target := h.path("file.txt")
			if placed {
				err = os.Link(stage, target)
			} else {
				err = os.WriteFile(target, []byte("content"), 0o644)
			}
			if err != nil {
				t.Fatal(err)
			}
			// JSON is the on-disk contract; emulate the staged intent left
			// by the interrupted agent, not any in-memory recovery state.
			b, err := json.Marshal(map[string]any{"commit_path": target, "commit_target": target, "commit_stage": stage})
			if err == nil {
				err = json.Unmarshal(b, rec)
			}
			if err == nil {
				err = h.st.PutUpload(t.Context(), rec)
			}
			if err != nil {
				t.Fatal(err)
			}
			res := h.commitDirect(h.ctx(), "copy", map[string]any{"path": target, "overwrite": false})
			if !placed {
				if res.Code != http.StatusConflict {
					t.Fatalf("unrelated target accepted: %d %s", res.Code, res.Body)
				}
				return
			}
			if res.Code != http.StatusOK {
				t.Fatalf("copy retry = %d %s", res.Code, res.Body)
			}
			if got := fileInfo(t, res.Body.Bytes()); got.GetPath() != target || got.GetSize() != 7 {
				t.Fatalf("committed file = %v", got)
			}
			for _, p := range []string{stage, rec.TempPath} {
				if _, err := os.Stat(p); !os.IsNotExist(err) {
					t.Errorf("temporary file remains: %s: %v", p, err)
				}
			}
		})
	}
}

func TestCommitCleanupFailureStillSucceeds(t *testing.T) {
	h := newHarness(t)
	wantStatus(t, h.do(http.MethodPut, "/files/uploads/cleanup", q("offset", "0"), strings.NewReader("content"), nil), http.StatusOK)
	rec, _, err := h.st.GetUpload("cleanup")
	if err != nil {
		t.Fatal(err)
	}
	stage := h.writeFile(".sbx-tmp-cleanup", []byte("content"), 0o644)
	target := h.path("file.txt")
	if err := os.Link(stage, target); err != nil {
		t.Fatal(err)
	}
	rec.CommitStage, rec.CommitPath, rec.CommitTarget = stage, target, target
	if err := h.st.PutUpload(t.Context(), rec); err != nil {
		t.Fatal(err)
	}
	// A nonempty directory cannot be removed by os.Remove, on every OS.
	// Emulate a cleanup failure without depending on host permissions.
	if err := os.Remove(rec.TempPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(rec.TempPath, 0o700); err != nil {
		t.Fatal(err)
	}
	blocked := rec.TempPath + string(os.PathSeparator) + "busy"
	if err := os.WriteFile(blocked, []byte("busy"), 0o600); err != nil {
		t.Fatal(err)
	}
	res := h.commitDirect(h.ctx(), "cleanup", map[string]any{"path": target, "overwrite": false})
	if res.Code != http.StatusOK {
		t.Fatalf("cleanup failure lost commit: %d %s", res.Code, res.Body)
	}
	if err := os.WriteFile(target, []byte("changed later"), 0o644); err != nil {
		t.Fatal(err)
	}
	if again := h.commitDirect(h.ctx(), "cleanup", map[string]any{"path": target}); again.Code != http.StatusOK || again.Body.String() != res.Body.String() {
		t.Fatalf("result was not durable: %d %s", again.Code, again.Body)
	}
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	h.clock.Add(DefaultUploadTTL + 1)
	h.svc.sweep(h.ctx())
	if _, err := os.Stat(rec.TempPath); !os.IsNotExist(err) {
		t.Fatalf("janitor did not retry source cleanup: %v", err)
	}
}

func TestCopiedUploadRetryBeforePlacement(t *testing.T) {
	h := newHarness(t)
	wantStatus(t, h.do(http.MethodPut, "/files/uploads/staged", q("offset", "0"), strings.NewReader("content"), nil), http.StatusOK)
	rec, _, err := h.st.GetUpload("staged")
	if err != nil {
		t.Fatal(err)
	}
	rec.CommitStage = h.writeFile(".sbx-tmp-staged", []byte("content"), 0o644)
	target := h.path("file.txt")
	rec.CommitPath, rec.CommitTarget = target, target
	if err := h.st.PutUpload(t.Context(), rec); err != nil {
		t.Fatal(err)
	}
	res := h.commitDirect(h.ctx(), "staged", map[string]any{"path": target, "overwrite": false})
	if res.Code != http.StatusOK {
		t.Fatalf("staged retry = %d %s", res.Code, res.Body)
	}
	if b, err := os.ReadFile(target); err != nil || string(b) != "content" {
		t.Fatalf("target = %q, %v", b, err)
	}
}
