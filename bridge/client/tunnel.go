package main

// One tunnel = one WebSocket + one TLS session pinned to the panel's key +
// one JSON request line and one JSON answer line, then whatever the request
// asked for (a control channel, a TCP stream, or framed UDP datagrams).

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

type answer struct {
	OK       bool      `json:"ok"`
	Code     string    `json:"code"`
	Error    string    `json:"error"`
	State    string    `json:"state"`
	Token    string    `json:"token"`
	Username string    `json:"username"`
	Panel    string    `json:"panel"`
	Forwards []forward `json:"forwards"`
	URLs     []string  `json:"urls"`
}

// panelError is a refusal from the panel itself (as opposed to a network
// problem), so retrying will not help.
type panelError struct{ Code, Message string }

func (e *panelError) Error() string { return e.Message }

type tunnel struct {
	*tls.Conn
	br *bufio.Reader
}

// Read drains anything buffered while reading the answer line first.
func (t *tunnel) Read(p []byte) (int, error) { return t.br.Read(p) }

type dialer struct {
	mu   sync.Mutex
	cfg  *config
	urls []string // best first; the last one that worked moves to the front
}

func newDialer(cfg *config, extra []string) *dialer {
	d := &dialer{cfg: cfg}
	d.setURLs(append(extra, cfg.URLs...))
	return d
}

func (d *dialer) setURLs(list []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	seen := map[string]bool{}
	var out []string
	for _, u := range list {
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	if len(out) > 0 {
		d.urls = out
	}
}

func (d *dialer) list() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.urls...)
}

func (d *dialer) preferred() string {
	l := d.list()
	if len(l) == 0 {
		return ""
	}
	return l[0]
}

func (d *dialer) worked(u string) {
	l := d.list()
	out := []string{u}
	for _, x := range l {
		if x != u {
			out = append(out, x)
		}
	}
	d.setURLs(out)
}

// open dials the panel (trying each known address) and sends one request.
func (d *dialer) open(req map[string]any) (*tunnel, *answer, error) {
	req["v"] = 1
	req["conn"] = d.cfg.Conn
	req["key"] = d.cfg.Key
	var lastErr error
	for _, u := range d.list() {
		t, a, err := d.openAt(u, req)
		if err == nil {
			d.worked(u)
			return t, a, nil
		}
		var pe *panelError
		if errors.As(err, &pe) {
			return nil, nil, err
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no panel address to connect to")
	}
	return nil, nil, lastErr
}

func (d *dialer) openAt(u string, req map[string]any) (*tunnel, *answer, error) {
	ws, err := dialWS(u, 15*time.Second)
	if err != nil {
		return nil, nil, err
	}
	pin, err := base64.StdEncoding.DecodeString(d.cfg.Pin)
	if err != nil || len(pin) != sha256.Size {
		ws.Close()
		return nil, nil, &panelError{"bad-stamp", "this download is damaged; get a new copy from the panel"}
	}
	conn := tls.Client(ws, &tls.Config{
		MinVersion: tls.VersionTLS13,
		ServerName: "gamepanel-bridge",
		// The certificate is self-signed; what matters is that it carries
		// exactly the key this download was stamped with. Anything else is
		// refused, which rules out interception.
		InsecureSkipVerify: true,
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("no certificate")
			}
			cert, err := x509.ParseCertificate(raw[0])
			if err != nil {
				return err
			}
			sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
			if subtle.ConstantTimeCompare(sum[:], pin) != 1 {
				return errPinMismatch
			}
			return nil
		},
	})
	conn.SetDeadline(time.Now().Add(20 * time.Second))
	if err := conn.Handshake(); err != nil {
		ws.Close()
		if errors.Is(err, errPinMismatch) {
			return nil, nil, errPinMismatch
		}
		return nil, nil, fmt.Errorf("secure handshake failed: %w", err)
	}
	line, _ := json.Marshal(req)
	if _, err := conn.Write(append(line, '\n')); err != nil {
		conn.Close()
		return nil, nil, err
	}
	br := bufio.NewReaderSize(conn, 32<<10)
	raw, err := br.ReadSlice('\n')
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("the panel did not answer: %w", err)
	}
	var a answer
	if err := json.Unmarshal(bytes.TrimSpace(raw), &a); err != nil {
		conn.Close()
		return nil, nil, errors.New("the panel sent an unreadable answer")
	}
	if !a.OK {
		conn.Close()
		msg := a.Error
		if msg == "" {
			msg = "the panel refused the request"
		}
		return nil, nil, &panelError{a.Code, msg}
	}
	conn.SetDeadline(time.Time{})
	return &tunnel{Conn: conn, br: br}, &a, nil
}

var errPinMismatch = errors.New("the panel's identity does not match this download. Someone may be intercepting the connection, or the panel was reinstalled; get a new copy from the panel")

// call is a one-shot request: send, read the answer, hang up.
func (d *dialer) call(req map[string]any) (*answer, error) {
	t, a, err := d.open(req)
	if err != nil {
		return nil, err
	}
	t.Close()
	return a, nil
}

func netErrorHint(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timed out"
	}
	return err.Error()
}
