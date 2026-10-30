package files

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestForgetUpload(t *testing.T) {
	h := newHarness(t)
	id := "upl_forget"
	res := h.do(http.MethodPut, "/files/uploads/"+id, q("offset", "0"), bytes.NewReader([]byte("pkg")), nil)
	wantStatus(t, res, http.StatusOK)
	temp := filepath.Join(h.layout.UploadsDir, id)
	if _, err := os.Stat(temp); err != nil {
		t.Fatal(err)
	}

	h.svc.ForgetUpload(id)
	if _, err := h.svc.UploadPath(id); err == nil {
		t.Error("upload still known after ForgetUpload")
	}
	if _, err := os.Stat(temp); !os.IsNotExist(err) {
		t.Errorf("temporary file kept: %v", err)
	}
	res = h.do(http.MethodHead, "/files/uploads/"+id, nil, nil, nil)
	wantStatus(t, res, http.StatusNotFound)

	h.svc.ForgetUpload("upl_unknown") // no record: nothing to do
}
