package ops

import (
	"bytes"
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

// EthersEntry is one static MAC to IP mapping that Proxmox writes for dnsmasq.
type EthersEntry struct {
	MAC string `json:"mac"`
	IP  string `json:"ip"`
}

func (s *Server) readOptional(path string) ([]byte, error) {
	data, err := fs.ReadFile(s.Host.FS, strings.TrimPrefix(path, "/"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (s *Server) readLeases() ([]Lease, error) {
	data, err := s.readOptional(s.Cfg.LeaseFile)
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

func parseEthers(data []byte) []EthersEntry {
	out := []EthersEntry{}
	for line := range strings.Lines(string(data)) {
		mac, rest, _ := strings.Cut(strings.TrimSpace(line), ",")
		if mac == "" {
			continue
		}
		ip, _, _ := strings.Cut(rest, ",")
		out = append(out, EthersEntry{MAC: strings.ToLower(mac), IP: ip})
	}
	return out
}

func (s *Server) dhcpLeases(_ context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	leases, err := s.readLeases()
	if err != nil {
		return nil, err
	}
	eth, err := s.readOptional(s.Cfg.EthersFile)
	if err != nil {
		return nil, err
	}
	return map[string]any{"leases": leases, "ethers": parseEthers(eth)}, nil
}

func (s *Server) inMacCache(mac string) (bool, error) {
	data, err := s.readOptional(s.Cfg.MacCacheFile)
	if err != nil || data == nil {
		return false, err
	}
	var cache struct {
		Macs map[string]json.RawMessage `json:"macs"`
	}
	if err := json.Unmarshal(data, &cache); err != nil {
		return false, err
	}
	for k := range cache.Macs {
		if strings.EqualFold(k, mac) {
			return true, nil
		}
	}
	return false, nil
}

// dhcpRelease drops the dnsmasq lease of one of our MACs and the static ethers line that
// Proxmox never removes on VM delete (it only prunes such lines on the next VM start).
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
	res := map[string]any{"released": false, "ethersRemoved": false, "inMacCache": false}

	leases, err := s.readLeases()
	if err != nil {
		return nil, err
	}
	for _, l := range leases {
		if l.MAC == mac {
			if _, err := s.Host.Run(ctx, "dhcp_release", s.Cfg.VNet, l.IP, mac); err != nil {
				return nil, err
			}
			res["released"], res["ip"] = true, l.IP
			break
		}
	}

	cached, err := s.inMacCache(mac)
	if err != nil {
		return nil, err
	}
	if cached {
		// The VM still owns the IP in IPAM: the mapping is live, leave it to Proxmox.
		res["inMacCache"] = true
		return res, nil
	}
	removed := false
	err = s.Host.Replace(s.Cfg.EthersFile, func(data []byte) ([]byte, error) {
		var out bytes.Buffer
		for line := range strings.Lines(string(data)) {
			m, _, _ := strings.Cut(strings.TrimSpace(line), ",")
			if strings.EqualFold(m, mac) {
				removed = true
				continue
			}
			out.WriteString(line)
		}
		return out.Bytes(), nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if removed {
		res["ethersRemoved"] = true
		if _, err := s.Host.Run(ctx, "systemctl", "reload", "dnsmasq@"+s.Cfg.SDNZone); err != nil {
			return nil, err
		}
	}
	return res, nil
}
