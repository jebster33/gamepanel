package main

// Local listeners on 127.0.0.1, one per shared port, each connection or UDP
// flow carried to the panel in its own tunnel.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"
)

type forward struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Group     string `json:"group"`
	Name      string `json:"name"`
	Port      int    `json:"port"`
	LocalPort int    `json:"localPort"`
	Protocol  string `json:"protocol"`
}

type listener struct {
	fwd    forward
	local  int
	closer io.Closer
	mu     sync.Mutex
	conns  map[io.Closer]struct{}
	closed bool
}

// forward is read from many goroutines while apply may rename it.
func (l *listener) forward() forward {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.fwd
}

func (l *listener) add(c io.Closer) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.conns[c] = struct{}{}
	return true
}

func (l *listener) remove(c io.Closer) {
	l.mu.Lock()
	delete(l.conns, c)
	l.mu.Unlock()
}

func (l *listener) close() {
	l.mu.Lock()
	l.closed = true
	conns := l.conns
	l.conns = map[io.Closer]struct{}{}
	l.mu.Unlock()
	l.closer.Close()
	for c := range conns {
		c.Close()
	}
}

type forwarder struct {
	d       *dialer
	token   func() string
	mu      sync.Mutex
	active  map[string]*listener
	chosen  map[int]int // wanted local port -> port actually used, so TCP and UDP of one port stay together
	lastErr map[string]time.Time
}

func newForwarder(d *dialer, token func() string) *forwarder {
	return &forwarder{d: d, token: token, active: map[string]*listener{}, chosen: map[int]int{}, lastErr: map[string]time.Time{}}
}

// apply opens listeners for new forwards and closes ones no longer shared.
func (f *forwarder) apply(list []forward) {
	f.mu.Lock()
	defer f.mu.Unlock()
	want := map[string]forward{}
	for _, fw := range list {
		if fw.Protocol == "tcp" || fw.Protocol == "udp" {
			want[fw.ID] = fw
		}
	}
	for id, l := range f.active {
		cur := l.forward()
		if fw, ok := want[id]; !ok || fw.Port != cur.Port || fw.LocalPort != cur.LocalPort {
			l.close()
			delete(f.active, id)
		} else {
			l.mu.Lock()
			l.fwd = fw // names may change
			l.mu.Unlock()
		}
	}
	// Stable order: same result every time for the same list.
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	for _, fw := range list {
		if _, ok := f.active[fw.ID]; ok || want[fw.ID].ID == "" {
			continue
		}
		l, err := f.listen(fw)
		if err != nil {
			warnf("Could not open a local port for %s %s (%s): %v", fw.Group, fw.Name, fw.Protocol, err)
			continue
		}
		f.active[fw.ID] = l
	}
}

func (f *forwarder) closeAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, l := range f.active {
		l.close()
		delete(f.active, id)
	}
}

func (f *forwarder) snapshot() []*listener {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*listener, 0, len(f.active))
	for _, l := range f.active {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i].forward(), out[j].forward()
		if a.Kind != b.Kind {
			return a.Kind == "server"
		}
		if a.Group != b.Group {
			return a.Group < b.Group
		}
		if a.Port != b.Port {
			return a.Port < b.Port
		}
		return a.Protocol > b.Protocol // tcp before udp
	})
	return out
}

func (f *forwarder) listen(fw forward) (*listener, error) {
	wanted := fw.wanted()
	var tries []int
	if p, ok := f.chosen[wanted]; ok {
		tries = append(tries, p)
	}
	tries = append(tries, wanted)
	for _, off := range []int{10000, 20000, 30000} {
		if p := wanted + off; p <= 65535 {
			tries = append(tries, p)
		}
	}
	tries = append(tries, 0)

	var lastErr error
	for _, port := range tries {
		addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
		l := &listener{fwd: fw, conns: map[io.Closer]struct{}{}}
		if fw.Protocol == "tcp" {
			ln, err := net.Listen("tcp", addr)
			if err != nil {
				lastErr = err
				continue
			}
			l.closer = ln
			l.local = ln.Addr().(*net.TCPAddr).Port
			go f.serveTCP(l, ln)
		} else {
			pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
			if err != nil {
				lastErr = err
				continue
			}
			l.closer = pc
			l.local = pc.LocalAddr().(*net.UDPAddr).Port
			go f.serveUDP(l, pc)
		}
		if _, ok := f.chosen[wanted]; !ok {
			f.chosen[wanted] = l.local
		}
		return l, nil
	}
	return nil, lastErr
}

// complain prints a tunnel failure, but not the same one over and over.
func (f *forwarder) complain(fw forward, err error) {
	f.mu.Lock()
	key := fw.ID + err.Error()
	last := f.lastErr[key]
	now := time.Now()
	if now.Sub(last) < 30*time.Second {
		f.mu.Unlock()
		return
	}
	f.lastErr[key] = now
	f.mu.Unlock()
	warnf("%s %s: %v", fw.Group, fw.Name, err)
}

/* ------------------------------------------------------------------- tcp -- */

func (f *forwarder) serveTCP(l *listener, ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(50 * time.Millisecond) // out of file handles and the like: keep serving
			continue
		}
		go f.handleTCP(l, c.(*net.TCPConn))
	}
}

func (f *forwarder) handleTCP(l *listener, local *net.TCPConn) {
	if !l.add(local) {
		local.Close()
		return
	}
	defer l.remove(local)
	local.SetNoDelay(true)
	fw := l.forward()
	t, _, err := f.d.open(map[string]any{"op": "tcp", "token": f.token(), "forward": fw.ID})
	if err != nil {
		local.Close()
		f.complain(fw, err)
		return
	}
	if !l.add(t) {
		local.Close()
		t.Close()
		return
	}
	defer l.remove(t)

	var once sync.Once
	closeAll := func() { local.Close(); t.Close() }
	done := make(chan struct{})
	go func() {
		// Local side finished sending: pass the half-close on, keep reading.
		if _, err := io.Copy(t, local); err != nil {
			once.Do(closeAll)
		} else {
			t.CloseWrite()
		}
		close(done)
	}()
	if _, err := io.Copy(local, t); err != nil {
		once.Do(closeAll)
	} else {
		local.CloseWrite()
	}
	<-done
	once.Do(closeAll)
}

/* ------------------------------------------------------------------- udp -- */

const udpIdle = 2 * time.Minute

type udpFlow struct {
	queue chan []byte
	last  time.Time
	t     *tunnel
	mu    sync.Mutex
	done  bool
}

func (u *udpFlow) Close() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return nil
	}
	u.done = true
	close(u.queue)
	if u.t != nil {
		u.t.Close()
	}
	return nil
}

func (f *forwarder) serveUDP(l *listener, pc *net.UDPConn) {
	var mu sync.Mutex
	flows := map[string]*udpFlow{}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				mu.Lock()
				for k, fl := range flows {
					fl.mu.Lock()
					idle := time.Since(fl.last) > udpIdle || fl.done
					fl.mu.Unlock()
					if idle {
						fl.Close()
						delete(flows, k)
					}
				}
				mu.Unlock()
			}
		}
	}()

	buf := make([]byte, 65535)
	for {
		n, from, err := pc.ReadFromUDP(buf)
		if err != nil && !errors.Is(err, net.ErrClosed) {
			// Windows reports an ICMP "port unreachable" from an earlier send
			// (a game that just closed) as a read error. The socket is fine.
			time.Sleep(5 * time.Millisecond)
			continue
		}
		if err != nil {
			mu.Lock()
			for _, fl := range flows {
				fl.Close()
			}
			mu.Unlock()
			return
		}
		packet := append([]byte(nil), buf[:n]...)
		key := from.String()
		mu.Lock()
		fl := flows[key]
		fl2 := fl
		if fl != nil {
			fl.mu.Lock()
			if fl.done {
				fl2 = nil
			}
			fl.mu.Unlock()
		}
		if fl2 == nil {
			fl = &udpFlow{queue: make(chan []byte, 512), last: time.Now()}
			flows[key] = fl
			if !l.add(fl) {
				mu.Unlock()
				return
			}
			go f.runFlow(l, pc, from, fl)
		}
		mu.Unlock()

		fl.mu.Lock()
		if !fl.done {
			fl.last = time.Now()
			select {
			case fl.queue <- packet:
			default: // full: drop, as a congested network would
			}
		}
		fl.mu.Unlock()
	}
}

func (f *forwarder) runFlow(l *listener, pc *net.UDPConn, peer *net.UDPAddr, fl *udpFlow) {
	defer l.remove(fl)
	defer fl.Close()
	fw := l.forward()
	t, _, err := f.d.open(map[string]any{"op": "udp", "token": f.token(), "forward": fw.ID})
	if err != nil {
		f.complain(fw, err)
		return
	}
	fl.mu.Lock()
	if fl.done {
		fl.mu.Unlock()
		t.Close()
		return
	}
	fl.t = t
	fl.mu.Unlock()

	// Panel -> game client.
	go func() {
		defer fl.Close()
		var hdr [2]byte
		payload := make([]byte, 65535)
		for {
			if _, err := io.ReadFull(t, hdr[:]); err != nil {
				return
			}
			n := int(binary.BigEndian.Uint16(hdr[:]))
			if _, err := io.ReadFull(t, payload[:n]); err != nil {
				return
			}
			fl.mu.Lock()
			fl.last = time.Now()
			fl.mu.Unlock()
			pc.WriteToUDP(payload[:n], peer)
		}
	}()

	// Game client -> panel.
	frame := make([]byte, 0, 65537)
	for packet := range fl.queue {
		frame = frame[:0]
		frame = binary.BigEndian.AppendUint16(frame, uint16(len(packet)))
		frame = append(frame, packet...)
		if _, err := t.Write(frame); err != nil {
			return
		}
	}
}

func describe(l *listener) string {
	return fmt.Sprintf("127.0.0.1:%d", l.local)
}

// wanted is the local port the panel asked for (the server's own by default).
func (fw forward) wanted() int {
	if fw.LocalPort > 0 {
		return fw.LocalPort
	}
	return fw.Port
}
