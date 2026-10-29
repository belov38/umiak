package ops

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"strconv"
	"strings"
)

// Lease is one line of the dnsmasq lease file.
type Lease struct {
	Expiry   int64  `json:"expiry"`
	MAC      string `json:"mac"`
	IP       string `json:"ip"`
	Hostname string `json:"hostname"`
	ClientID string `json:"clientId"`
}

func (s *Server) readLeases() ([]Lease, error) {
	data, err := fs.ReadFile(s.Host.FS, strings.TrimPrefix(s.Cfg.LeaseFile, "/"))
	if errors.Is(err, fs.ErrNotExist) {
		return []Lease{}, nil
	}
	if err != nil {
		return nil, err
	}
	leases := []Lease{}
	for line := range strings.Lines(string(data)) {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		exp, _ := strconv.ParseInt(f[0], 10, 64)
		l := Lease{Expiry: exp, MAC: strings.ToLower(f[1]), IP: f[2], Hostname: f[3]}
		if len(f) > 4 {
			l.ClientID = f[4]
		}
		leases = append(leases, l)
	}
	return leases, nil
}

func (s *Server) dhcpLeases(_ context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	leases, err := s.readLeases()
	if err != nil {
		return nil, err
	}
	return map[string]any{"leases": leases}, nil
}

func (s *Server) dhcpRelease(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		MAC string `json:"mac"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	if _, err := ValidMAC(s.Cfg, args.MAC); err != nil {
		return nil, err
	}
	mac := strings.ToLower(args.MAC)
	leases, err := s.readLeases()
	if err != nil {
		return nil, err
	}
	for _, l := range leases {
		if l.MAC == mac {
			if _, err := s.Host.Run(ctx, "dhcp_release", s.Cfg.VNet, l.IP, mac); err != nil {
				return nil, err
			}
			return map[string]any{"released": true, "ip": l.IP}, nil
		}
	}
	return map[string]any{"released": false}, nil
}
