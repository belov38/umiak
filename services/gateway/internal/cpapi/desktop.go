package cpapi

import (
	"context"
	"encoding/json"
	"net/http"
)

// DesktopOpen identifies the paired host and app, never streamer credentials.
type DesktopOpen struct {
	HostID string `json:"hostId"`
	AppID  string `json:"appId"`
}

// DesktopClient is the S10 extension; older stand-ins fail closed when absent.
type DesktopClient interface {
	ExchangeDesktopTicket(context.Context, string, string) (PortAuthGrant, error)
	OpenDesktop(context.Context, string) (DesktopOpen, error)
}

// Desktop returns the extension implemented by the real API client, or nil.
func Desktop(client Client) DesktopClient { d, _ := client.(DesktopClient); return d }

func (c *httpClient) ExchangeDesktopTicket(ctx context.Context, ticket, label string) (PortAuthGrant, error) {
	payload, _ := json.Marshal(map[string]string{"ticket": ticket, "label": label})
	status, body, err := c.do(ctx, http.MethodPost, "/internal/v1/gateway/desktop/tickets/exchange", payload)
	if err != nil {
		return PortAuthGrant{}, err
	}
	if status == http.StatusBadRequest || status == http.StatusUnauthorized {
		return PortAuthGrant{}, ErrInvalidCode
	}
	if status != http.StatusOK {
		return PortAuthGrant{}, ErrUnavailable
	}
	var g PortAuthGrant
	if err = json.Unmarshal(body, &g); err != nil || g.Label != label || g.AuthEpoch < 1 {
		return PortAuthGrant{}, ErrUnavailable
	}
	return g, nil
}
func (c *httpClient) OpenDesktop(ctx context.Context, label string) (DesktopOpen, error) {
	payload, _ := json.Marshal(map[string]string{"label": label})
	status, body, err := c.do(ctx, http.MethodPost, "/internal/v1/gateway/desktop/open", payload)
	if err != nil {
		return DesktopOpen{}, err
	}
	if status != http.StatusOK {
		return DesktopOpen{}, ErrUnavailable
	}
	var o DesktopOpen
	if err = json.Unmarshal(body, &o); err != nil || o.HostID == "" || o.AppID == "" {
		return DesktopOpen{}, ErrUnavailable
	}
	return o, nil
}
