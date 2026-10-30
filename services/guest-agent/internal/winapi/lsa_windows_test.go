package winapi

import (
	"bytes"
	"errors"
	"os"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Needs SYSTEM or an administrator (LSA private data).
func TestLsaStoreRetrieveDelete(t *testing.T) {
	name := "L$sbx_test_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	data := []byte("pa55-wörd\x00tail")
	if err := LsaStore(name, data); err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			t.Skip("not privileged:", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = LsaStore(name, nil) })
	got, err := LsaRetrieve(name)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("LsaRetrieve = %q, %v", got, err)
	}
	if err := LsaStore(name, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := LsaRetrieve(name); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted secret: %v", err)
	}
	// Deleting again is fine.
	if err := LsaStore(name, nil); err != nil {
		t.Fatal(err)
	}
}

func TestLogonUserTokenUnknownUser(t *testing.T) {
	if _, err := LogonUserToken("sbx-no-such-user", "x"); err == nil {
		t.Fatal("logon of an unknown user succeeded")
	}
}
