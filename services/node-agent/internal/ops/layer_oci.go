package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const defaultLayerRegistry = "https://ghcr.io"

var defaultLayerRepositories = map[string]string{"linux": "belov38/umiak-linux-layer", "linux-desktop": "belov38/umiak-linux-desktop-layer"}
var layerRepoRE = regexp.MustCompile(`^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$`)

func layerRegistryBase(registry, repository string) (string, error) {
	u, e := url.Parse(registry)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || !layerRepoRE.MatchString(repository) || len(repository) > 255 {
		return "", errors.New("invalid OCI registry/repository configuration")
	}
	u.Path = "/v2/" + repository
	return u.String(), nil
}
func layerOCIRedirectAllowed(origin, target *url.URL) bool {
	return target.Scheme == "https" && target.User == nil && (strings.EqualFold(target.Host, origin.Host) || (origin.Hostname() == "ghcr.io" && target.Hostname() == "pkg-containers.githubusercontent.com" && (target.Port() == "" || target.Port() == "443")))
}

type layerOCITransport struct {
	transport  http.RoundTripper
	origin     *url.URL
	repository string
	mu         sync.Mutex
	token      string
	expires    time.Time
}

func layerOCIClient(client *http.Client, base string) (*http.Client, error) {
	u, e := url.Parse(base)
	if e != nil || !strings.HasPrefix(u.Path, "/v2/") {
		return nil, errors.New("invalid OCI repository base")
	}
	repository := strings.TrimPrefix(u.Path, "/v2/")
	if !layerRepoRE.MatchString(repository) {
		return nil, errors.New("invalid OCI repository")
	}
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""
	copyClient := *client
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	copyClient.Transport = &layerOCITransport{transport: transport, origin: u, repository: repository}
	copyClient.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !layerOCIRedirectAllowed(u, r.URL) {
			return errors.New("OCI redirect outside allowed origins")
		}
		return nil
	}
	return &copyClient, nil
}
func (t *layerOCITransport) RoundTrip(request *http.Request) (*http.Response, error) {
	r := request.Clone(request.Context())
	r.Header = request.Header.Clone()
	if r.URL.Host != t.origin.Host || r.URL.Scheme != t.origin.Scheme {
		r.Header.Del("Authorization")
		r.Header.Del("Cookie")
		return t.transport.RoundTrip(r)
	}
	t.mu.Lock()
	token := t.token
	if time.Now().After(t.expires) {
		token = ""
	}
	t.mu.Unlock()
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	} else {
		r.Header.Del("Authorization")
	}
	response, e := t.transport.RoundTrip(r)
	if e != nil {
		return nil, errors.New("OCI registry request failed")
	}
	if response.StatusCode != 401 {
		return response, nil
	}
	challenge := response.Header.Get("WWW-Authenticate")
	_ = response.Body.Close()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token == token || time.Now().After(t.expires) {
		if e = t.authenticate(request.Context(), challenge); e != nil {
			return nil, e
		}
	}
	r = request.Clone(request.Context())
	r.Header = request.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+t.token)
	return t.transport.RoundTrip(r)
}
func (t *layerOCITransport) authenticate(ctx context.Context, challenge string) error {
	if !strings.HasPrefix(strings.ToLower(challenge), "bearer ") {
		return errors.New("OCI package must be Public for anonymous pulls")
	}
	fields := map[string]string{}
	for _, m := range regexp.MustCompile(`(?i)([a-z_]+)="([^"\r\n]*)"`).FindAllStringSubmatch(challenge, -1) {
		k := strings.ToLower(m[1])
		if _, ok := fields[k]; ok {
			return errors.New("invalid OCI auth challenge")
		}
		fields[k] = m[2]
	}
	realm, e := url.Parse(fields["realm"])
	if e != nil || realm.Scheme != "https" || realm.Host != t.origin.Host || realm.User != nil || realm.Fragment != "" {
		return errors.New("OCI auth realm escaped configured origin")
	}
	scope := "repository:" + t.repository + ":pull"
	if fields["scope"] != "" && fields["scope"] != scope {
		return errors.New("OCI auth requested a different repository scope")
	}
	service := fields["service"]
	if service == "" {
		service = t.origin.Host
	}
	query := realm.Query()
	query.Set("service", service)
	query.Set("scope", scope)
	realm.RawQuery = query.Encode()
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, realm.String(), nil)
	if e != nil {
		return errors.New("invalid OCI token request")
	}
	req.Header.Set("Accept", "application/json")
	response, e := t.transport.RoundTrip(req)
	if e != nil {
		return errors.New("OCI anonymous token request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 {
		return fmt.Errorf("OCI anonymous pull denied (HTTP %d); set package visibility to Public", response.StatusCode)
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, 32769))
	if e != nil || len(data) > 32768 {
		return errors.New("invalid OCI anonymous token response")
	}
	var token struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if json.Unmarshal(data, &token) != nil {
		return errors.New("invalid OCI anonymous token response")
	}
	if token.Token == "" {
		token.Token = token.AccessToken
	}
	if len(token.Token) > 16384 || !regexp.MustCompile(`^[A-Za-z0-9._~+/-]+=*$`).MatchString(token.Token) {
		return errors.New("invalid OCI anonymous token response")
	}
	if token.ExpiresIn == 0 {
		token.ExpiresIn = 300
	}
	t.token = token.Token
	t.expires = time.Now().Add(time.Duration(min(3600, max(30, token.ExpiresIn))-10) * time.Second)
	return nil
}
