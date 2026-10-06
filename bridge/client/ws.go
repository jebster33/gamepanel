package main

// A minimal RFC 6455 client carrying a byte stream in binary frames, exposed
// as a net.Conn so TLS can run inside it. The WebSocket layer is only there
// so the tunnel passes through whatever the panel's dashboard passes through
// (reverse proxies, Cloudflare Tunnel); security comes from the pinned TLS
// that runs over it.

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	wsGUID     = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F"
	wsProtocol = "gamepanel-bridge.v1"
	maxFrame   = 1 << 20
	outChunk   = 32 << 10
)

type wsConn struct {
	net.Conn
	br        *bufio.Reader
	wmu       sync.Mutex
	remaining int64 // unread bytes of the current data frame
	rmask     bool
	closed    bool
}

// dialWS opens a WebSocket to <panel>/bridge/tunnel.
func dialWS(panelURL string, timeout time.Duration) (*wsConn, error) {
	u, err := url.Parse(panelURL)
	if err != nil {
		return nil, err
	}
	secure := u.Scheme == "https"
	if !secure && u.Scheme != "http" {
		return nil, fmt.Errorf("unsupported address %q", panelURL)
	}
	host := u.Host
	if u.Port() == "" {
		if secure {
			host = net.JoinHostPort(u.Hostname(), "443")
		} else {
			host = net.JoinHostPort(u.Hostname(), "80")
		}
	}
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	var conn net.Conn
	if secure {
		// The outer TLS (an https panel or a proxy in front of it) is only
		// transport. Who we are talking to is proven by the inner TLS, which is
		// pinned to the panel's own key, so a proxy's certificate need not be
		// publicly trusted for the bridge to be safe.
		conn, err = tls.DialWithDialer(dialer, "tcp", host, &tls.Config{ServerName: u.Hostname(), InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.Dial("tcp", host)
	}
	if err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(timeout))

	keyBytes := make([]byte, 16)
	rand.Read(keyBytes)
	key := base64.StdEncoding.EncodeToString(keyBytes)
	path := strings.TrimRight(u.EscapedPath(), "/") + "/bridge/tunnel"
	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Protocol: " + wsProtocol + "\r\n" +
		"User-Agent: GamePanel-Bridge/" + version + "\r\n\r\n"
	if _, err := io.WriteString(conn, req); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReaderSize(conn, 64<<10)
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		conn.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		switch resp.StatusCode {
		case 404:
			return nil, errBridgeOff
		case 429:
			return nil, errors.New("the panel is busy, try again in a moment")
		}
		return nil, fmt.Errorf("the panel answered %s", resp.Status)
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		conn.Close()
		return nil, errors.New("this address is not a GamePanel (bad WebSocket handshake)")
	}
	conn.SetDeadline(time.Time{})
	return &wsConn{Conn: conn, br: br}, nil
}

var errBridgeOff = errors.New("the bridge is turned off on this panel (or this is not a GamePanel address)")

func (c *wsConn) Read(p []byte) (int, error) {
	for c.remaining == 0 {
		if err := c.nextFrame(); err != nil {
			return 0, err
		}
	}
	if int64(len(p)) > c.remaining {
		p = p[:c.remaining]
	}
	n, err := c.br.Read(p)
	c.remaining -= int64(n)
	if err == io.EOF && c.remaining > 0 {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

// nextFrame reads frame headers until a data frame with payload starts,
// answering pings and stopping at a close.
func (c *wsConn) nextFrame() error {
	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return err
	}
	opcode := hdr[0] & 0x0f
	if hdr[1]&0x80 != 0 {
		return errors.New("server frames must not be masked")
	}
	size := int64(hdr[1] & 0x7f)
	switch size {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(c.br, b[:]); err != nil {
			return err
		}
		size = int64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(c.br, b[:]); err != nil {
			return err
		}
		size = int64(binary.BigEndian.Uint64(b[:]))
	}
	if size > maxFrame || size < 0 {
		return errors.New("frame too large")
	}
	switch opcode {
	case 0x0, 0x2:
		c.remaining = size
		return nil
	case 0x8:
		io.CopyN(io.Discard, c.br, size)
		c.writeFrame(0x8, []byte{0x03, 0xe8})
		return io.EOF
	case 0x9:
		payload := make([]byte, size)
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return err
		}
		return c.writeFrame(0xa, payload)
	case 0xa:
		_, err := io.CopyN(io.Discard, c.br, size)
		return err
	default:
		return fmt.Errorf("unexpected frame %d", opcode)
	}
}

func (c *wsConn) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := len(p)
		if n > outChunk {
			n = outChunk
		}
		if err := c.writeFrame(0x2, p[:n]); err != nil {
			return written, err
		}
		written += n
		p = p[n:]
	}
	return written, nil
}

func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	n := len(payload)
	frame := make([]byte, 0, 14+n)
	frame = append(frame, 0x80|opcode)
	switch {
	case n < 126:
		frame = append(frame, 0x80|byte(n))
	case n < 65536:
		frame = append(frame, 0x80|126, byte(n>>8), byte(n))
	default:
		frame = append(frame, 0x80|127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(n))
	}
	var mask [4]byte
	rand.Read(mask[:])
	frame = append(frame, mask[:]...)
	start := len(frame)
	frame = append(frame, payload...)
	for i := range payload {
		frame[start+i] ^= mask[i&3]
	}
	_, err := c.Conn.Write(frame)
	if opcode == 0x8 {
		c.closed = true
	}
	return err
}

func (c *wsConn) Close() error {
	c.writeFrame(0x8, []byte{0x03, 0xe8})
	return c.Conn.Close()
}
