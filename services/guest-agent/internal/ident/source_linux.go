package ident

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Read reads product_serial, product_uuid, product_family and the boot id. A
// missing or unreadable serial is an error; the other values are optional. The
// serial is never included in an error message.
func (s SysfsSource) Read(ctx context.Context) (Raw, error) {
	if err := ctx.Err(); err != nil {
		return Raw{}, err
	}
	var raw Raw
	serial, err := os.ReadFile(filepath.Join(s.Dir, "product_serial"))
	if err != nil {
		return Raw{}, fmt.Errorf("ident: read product_serial: %w", err)
	}
	sku, err := os.ReadFile(filepath.Join(s.Dir, "product_sku"))
	if err != nil && !os.IsNotExist(err) {
		return Raw{}, fmt.Errorf("ident: read product_sku: %w", err)
	}
	raw.SKU = strings.TrimSpace(string(sku))
	raw.Serial = strings.TrimSpace(string(serial))
	raw.UUID = readOptional(filepath.Join(s.Dir, "product_uuid"))
	raw.Family = readOptional(filepath.Join(s.Dir, "product_family"))
	if s.BootIDPath != "" {
		raw.BootID = readOptional(s.BootIDPath)
	}
	return raw, nil
}

// readOptional returns the trimmed content of path, or "" if it cannot be read.
func readOptional(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
