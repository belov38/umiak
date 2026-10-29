package cpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// maxBody caps every response body read from api.
	maxBody = 64 << 10

	pathRoutes   = "/internal/v1/gateway/routes/"
	pathExchange = "/internal/v1/gateway/port-auth/exchange"
	pathSSH      = "/internal/v1/gateway/ssh/authorize"

	defaultHTTPTimeout = 10 * time.Second
)

type httpClient struct {
	base  string
	token string
	hc    *http.Client
}

// NewHTTPClient returns a Client that calls api at baseURL with the service
// token as a bearer credential. hc may be nil. The client never follows
// redirects (a copy of hc is used, so the caller's client is not modified) and
// reads at most 64 KiB of any response.
func NewHTTPClient(baseURL, token string, hc *http.Client) Client {
	var c http.Client
	if hc != nil {
		c = *hc
	} else {
		c.Timeout = defaultHTTPTimeout
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &httpClient{base: strings.TrimRight(baseURL, "/"), token: token, hc: &c}
}

// errorBody is the {"code": ...} body of api error answers.
type errorBody struct {
	Code string `json:"code"`
}

func (c *httpClient) LookupRoute(ctx context.Context, label string) (Route, error) {
	status, body, err := c.do(ctx, http.MethodGet, pathRoutes+url.PathEscape(label), nil)
	if err != nil {
		return Route{}, err
	}
	switch status {
	case http.StatusOK:
		var r Route
		if err := json.Unmarshal(body, &r); err != nil {
			return Route{}, fmt.Errorf("%w: decode route: %w", ErrUnavailable, err)
		}
		// The cache stores the answer under the requested label; a route for
		// another label would serve one tenant's app on another's host name.
		if r.Label != label {
			return Route{}, fmt.Errorf("%w: route lookup: answer for label %q, want %q", ErrUnavailable, r.Label, label)
		}
		r.normalize()
		return r, nil
	case http.StatusNotFound:
		// Only the documented body counts as "no such route". Any other 404
		// (a wrong base URL, a proxy) must not be cached as a real answer.
		if errorCode(body) == "route_not_found" {
			return Route{}, ErrRouteNotFound
		}
	}
	return Route{}, statusError("route lookup", status)
}

func (c *httpClient) ExchangePortAuthCode(ctx context.Context, code, label string) (PortAuthGrant, error) {
	payload, err := json.Marshal(struct {
		Code  string `json:"code"`
		Label string `json:"label"`
	}{code, label})
	if err != nil {
		return PortAuthGrant{}, fmt.Errorf("%w: encode exchange: %w", ErrUnavailable, err)
	}
	status, body, err := c.do(ctx, http.MethodPost, pathExchange, payload)
	if err != nil {
		return PortAuthGrant{}, err
	}
	switch status {
	case http.StatusOK:
		var g PortAuthGrant
		if err := json.Unmarshal(body, &g); err != nil {
			return PortAuthGrant{}, fmt.Errorf("%w: decode grant: %w", ErrUnavailable, err)
		}
		return g, nil
	case http.StatusBadRequest:
		if errorCode(body) == "invalid_code" {
			return PortAuthGrant{}, ErrInvalidCode
		}
	}
	return PortAuthGrant{}, statusError("port-auth exchange", status)
}

func (c *httpClient) AuthorizeSSH(ctx context.Context, req SSHAuthorizeRequest) (SSHAuthorization, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return SSHAuthorization{}, fmt.Errorf("%w: encode ssh request: %w", ErrUnavailable, err)
	}
	status, body, err := c.do(ctx, http.MethodPost, pathSSH, payload)
	if err != nil {
		return SSHAuthorization{}, err
	}
	if status != http.StatusOK {
		return SSHAuthorization{}, statusError("ssh authorize", status)
	}
	var a SSHAuthorization
	if err := json.Unmarshal(body, &a); err != nil {
		return SSHAuthorization{}, fmt.Errorf("%w: decode ssh authorization: %w", ErrUnavailable, err)
	}
	return a, nil
}

// do sends one request and reads the capped body. Transport failures, a
// redirect and an oversized body come back as ErrUnavailable; the HTTP status
// is returned for the caller to interpret.
func (c *httpClient) do(ctx context.Context, method, path string, payload []byte) (int, []byte, error) {
	var rd io.Reader
	if payload != nil {
		rd = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: build request: %w", ErrUnavailable, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: %s: %w", ErrUnavailable, method, err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return 0, nil, fmt.Errorf("%w: read response: %w", ErrUnavailable, err)
	}
	if len(body) > maxBody {
		return 0, nil, fmt.Errorf("%w: response larger than %d bytes", ErrUnavailable, maxBody)
	}
	return resp.StatusCode, body, nil
}

func errorCode(body []byte) string {
	var e errorBody
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	return e.Code
}

func statusError(what string, status int) error {
	if status >= 300 && status < 400 {
		return fmt.Errorf("%w: %s: unexpected redirect (status %d)", ErrUnavailable, what, status)
	}
	return fmt.Errorf("%w: %s: status %d", ErrUnavailable, what, status)
}
