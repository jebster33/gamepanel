// GamePanel Bridge: reach the game servers a GamePanel shares with you,
// through the panel's own address, without anyone opening ports.
//
// Each download is personal: the panel appends who it is for, where the
// panel lives and the key its TLS identity must have (see stamp.go). Run it,
// sign in (or choose a password the first time), and the shared servers
// appear on 127.0.0.1 for as long as the window stays open.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

var version = "dev"

var stdin = bufio.NewReader(os.Stdin)

func main() {
	logout := flag.Bool("logout", false, "sign this device out and forget the saved login")
	uninstall := flag.Bool("uninstall", false, "sign out and remove everything GamePanel Bridge stored on this computer")
	showVersion := flag.Bool("version", false, "print the version")
	urlOverride := flag.String("url", "", "connect to this panel address instead of the one in the download")
	flag.Parse()

	if *showVersion {
		fmt.Println("GamePanel Bridge", version)
		return
	}
	setupConsole()
	code := run(*logout, *uninstall, *urlOverride)
	pauseIfOwnWindow()
	os.Exit(code)
}

func run(logout, uninstall bool, urlOverride string) int {
	exe, err := os.Executable()
	if err != nil {
		errorf("%v", err)
		return 1
	}
	cfg, err := readStamp(exe)
	if err != nil {
		errorf("%v", err)
		return 1
	}
	setTitle("GamePanel Bridge · " + cfg.Panel)
	banner(cfg)

	saved := loadSaved(cfg)
	var extra []string
	if urlOverride != "" {
		extra = append(extra, strings.TrimRight(urlOverride, "/"))
	}
	if saved.URL != "" {
		extra = append(extra, saved.URL)
	}
	d := newDialer(cfg, extra)

	if uninstall {
		return doUninstall(cfg, d, saved, exe, func() bool {
			line, _ := stdin.ReadString('\n')
			return strings.EqualFold(strings.TrimSpace(line), "yes")
		})
	}
	if logout {
		if saved.Token != "" {
			d.call(map[string]any{"op": "logout", "token": saved.Token})
		}
		forget(cfg)
		okf("Signed out. Your saved login was removed from this computer.")
		return 0
	}

	token := saved.Token
	for {
		if token == "" {
			token, err = signIn(cfg, d)
			if err != nil {
				errorf("%v", err)
				return 1
			}
			saveState(cfg, &saved, d, token)
		}
		started, err := connect(cfg, d, &saved, token)
		if err == nil {
			return 0 // quit
		}
		var pe *panelError
		if errors.As(err, &pe) && (pe.Code == "bad-token" || pe.Code == "needs-password") {
			// The admin reset the password or signed this device out.
			token = ""
			forget(cfg)
			reset := pe.Code == "needs-password"
			if started {
				// The console is already being read for commands; asking for a
				// password now would race it. The next launch asks instead.
				if reset {
					warnf("The panel administrator reset your password. Run GamePanel Bridge again to choose a new one.")
				} else {
					warnf("This device was signed out by the panel administrator. Run GamePanel Bridge again to sign in.")
				}
				return 0
			}
			if reset {
				infof("Your password was reset by the panel administrator. Choose a new one.")
			} else {
				infof("This device was signed out. Sign in again.")
			}
			continue
		}
		errorf("%v", err)
		return 1
	}
}

/* ------------------------------------------------------------- sign in -- */

func signIn(cfg *config, d *dialer) (string, error) {
	hello, err := withRetry(d, func() (*answer, error) { return d.call(map[string]any{"op": "hello"}) })
	if err != nil {
		return "", err
	}
	host, _ := os.Hostname()
	device := map[string]any{"name": host, "os": runtime.GOOS + "/" + runtime.GOARCH}

	if hello.State == "set-password" {
		fmt.Println()
		infof("Welcome, %s! Choose a password for your account (at least 8 characters).", cfg.User)
		for {
			pw, err := readPassword("  New password: ")
			if err != nil {
				return "", err
			}
			if len(pw) < 8 {
				warnf("That is shorter than 8 characters, try again.")
				continue
			}
			again, err := readPassword("  Type it again: ")
			if err != nil {
				return "", err
			}
			if pw != again {
				warnf("Those did not match, try again.")
				continue
			}
			a, err := d.call(map[string]any{"op": "set-password", "password": pw, "device": device})
			if err != nil {
				var pe *panelError
				if errors.As(err, &pe) && pe.Code == "weak-password" {
					warnf("%s", pe.Message)
					continue
				}
				if errors.As(err, &pe) && pe.Code == "exists" {
					// Someone (probably you, on another computer) just set it.
					return signInWithPassword(cfg, d, device)
				}
				return "", err
			}
			okf("Password saved. You will not be asked again on this computer.")
			return a.Token, nil
		}
	}
	return signInWithPassword(cfg, d, device)
}

func signInWithPassword(cfg *config, d *dialer, device map[string]any) (string, error) {
	fmt.Println()
	infof("Sign in as %s.", cfg.User)
	for attempt := 0; ; attempt++ {
		pw, err := readPassword("  Password: ")
		if err != nil {
			return "", err
		}
		a, err := d.call(map[string]any{"op": "login", "password": pw, "device": device})
		if err == nil {
			okf("Signed in.")
			return a.Token, nil
		}
		var pe *panelError
		if errors.As(err, &pe) {
			switch pe.Code {
			case "bad-password", "rate-limited":
				warnf("%s", pe.Message)
				if attempt >= 9 {
					return "", errors.New("too many attempts")
				}
				continue
			case "needs-password":
				return signIn(cfg, d)
			}
		}
		return "", err
	}
}

// withRetry keeps trying while the panel is unreachable (not when it refuses).
func withRetry(d *dialer, fn func() (*answer, error)) (*answer, error) {
	delay := 2 * time.Second
	for {
		a, err := fn()
		if err == nil {
			return a, nil
		}
		var pe *panelError
		if errors.As(err, &pe) || errors.Is(err, errPinMismatch) {
			return nil, err
		}
		warnf("Can't reach the panel at %s (%s). Retrying in %s…", d.preferred(), netErrorHint(err), delay)
		time.Sleep(delay)
		if delay < 30*time.Second {
			delay *= 2
		}
	}
}

/* ------------------------------------------------------------- running -- */

// connect keeps the control channel up and the local ports open until the
// user quits (nil) or the panel withdraws access (an error).
func connect(cfg *config, d *dialer, saved *savedState, token string) (started bool, err error) {
	fw := newForwarder(d, func() string { return token })
	defer fw.closeAll()

	commands := make(chan string)
	var once sync.Once
	startCommands := func() {
		once.Do(func() {
			go func() {
				for {
					line, err := stdin.ReadString('\n')
					cmd := strings.ToLower(strings.TrimSpace(line))
					if cmd != "" {
						commands <- cmd
					}
					if err != nil {
						return // no console (running in the background): keep going
					}
				}
			}()
		})
	}
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupt)

	delay := 2 * time.Second
	first := true
	for {
		t, a, err := d.open(map[string]any{"op": "control", "token": token})
		if err != nil {
			var pe *panelError
			if errors.As(err, &pe) {
				switch pe.Code {
				case "bad-token", "needs-password":
					return !first, err
				case "disabled", "rate-limited":
					warnf("%s. Trying again in a minute…", strings.TrimRight(pe.Message, "."))
					if waitOrQuit(time.Minute, commands, interrupt) {
						return !first, nil
					}
					continue
				}
				return !first, err
			}
			if errors.Is(err, errPinMismatch) {
				return !first, err
			}
			warnf("Can't reach the panel at %s (%s). Retrying in %s…", d.preferred(), netErrorHint(err), delay)
			if waitOrQuit(delay, commands, interrupt) {
				return !first, nil
			}
			if delay < 30*time.Second {
				delay *= 2
			}
			continue
		}
		delay = 2 * time.Second
		if len(a.URLs) > 0 {
			d.setURLs(append([]string{d.preferred()}, a.URLs...))
		}
		saveState(cfg, saved, d, token)
		fw.apply(a.Forwards)
		if first {
			okf("Connected to %s.", a.Panel)
			first = false
		} else {
			okf("Reconnected.")
		}
		printForwards(fw)
		startCommands()

		quit, err := session(t, fw, commands, interrupt, cfg, d, token)
		t.Close()
		if quit {
			return true, nil
		}
		if err != nil {
			return true, err
		}
		warnf("Lost the connection to the panel. Reconnecting…")
	}
}

type controlMsg struct {
	Type     string    `json:"type"`
	Reason   string    `json:"reason"`
	Forwards []forward `json:"forwards"`
}

// session runs one control connection. quit=true means the user is done.
func session(t *tunnel, fw *forwarder, commands <-chan string, interrupt <-chan os.Signal, cfg *config, d *dialer, token string) (quit bool, err error) {
	msgs := make(chan controlMsg)
	readErr := make(chan error, 1)
	go func() {
		for {
			line, err := t.br.ReadBytes('\n')
			if err != nil {
				readErr <- err
				return
			}
			var m controlMsg
			if json.Unmarshal(line, &m) == nil {
				msgs <- m
			}
		}
	}()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	var wmu sync.Mutex
	send := func(v any) {
		wmu.Lock()
		defer wmu.Unlock()
		b, _ := json.Marshal(v)
		t.SetWriteDeadline(time.Now().Add(15 * time.Second))
		t.Write(append(b, '\n'))
	}

	heard := time.Now()
	for {
		select {
		case <-ping.C:
			// The panel answers every ping; silence means the link is dead
			// even if the operating system has not noticed yet.
			if time.Since(heard) > 65*time.Second {
				return false, nil
			}
			go send(map[string]string{"type": "ping"})
		case m := <-msgs:
			heard = time.Now()
			switch m.Type {
			case "forwards":
				fw.apply(m.Forwards)
				infof("The panel changed what is shared with you:")
				printForwards(fw)
			case "revoked":
				fw.closeAll()
				switch m.Reason {
				case "password-reset":
					return false, &panelError{"needs-password", "password reset"}
				case "signed-out":
					return false, &panelError{"bad-token", "signed out"}
				case "disabled":
					warnf("The panel administrator turned this connection off.")
					return false, nil
				case "deleted", "replaced":
					return false, errors.New("this copy of GamePanel Bridge is no longer valid. Ask for a new download")
				}
				return false, nil
			}
		case <-readErr:
			return false, nil
		case <-interrupt:
			return true, nil
		case cmd := <-commands:
			switch cmd {
			case "q", "quit", "exit", "stop":
				return true, nil
			case "s", "status":
				printForwards(fw)
			case "logout", "sign out", "signout":
				d.call(map[string]any{"op": "logout", "token": token})
				forget(cfg)
				okf("Signed out and removed the saved login from this computer.")
				return true, nil
			case "uninstall":
				exe, _ := os.Executable()
				saved := loadSaved(cfg)
				// The console is being read for commands, so the answer comes from there.
				doUninstall(cfg, d, saved, exe, func() bool {
					select {
					case answer := <-commands:
						return answer == "yes"
					case <-time.After(2 * time.Minute):
						return false
					}
				})
				return true, nil
			default:
				infof("Commands: status, logout, uninstall, quit")
			}
		}
	}
}

func waitOrQuit(d time.Duration, commands <-chan string, interrupt <-chan os.Signal) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			return false
		case <-interrupt:
			return true
		case cmd := <-commands:
			if cmd == "q" || cmd == "quit" || cmd == "exit" {
				return true
			}
		}
	}
}

func printForwards(fw *forwarder) {
	list := fw.snapshot()
	fmt.Println()
	if len(list) == 0 {
		infof("Nothing is shared with you yet. Ask the panel administrator to add a server; it will appear here by itself.")
		fmt.Println()
		return
	}
	group := ""
	for _, l := range list {
		fw := l.forward()
		if fw.Group != group {
			group = fw.Group
			fmt.Printf("  %s\n", bold(group))
		}
		note := ""
		if l.local != fw.wanted() {
			note = dim(fmt.Sprintf("  (port %d was busy on this computer)", fw.wanted()))
		}
		fmt.Printf("    %-22s %s  %s%s\n", fw.Name, accent(describe(l)), dim(strings.ToUpper(fw.Protocol)), note)
	}
	fmt.Println()
	fmt.Println(dim("  Connect your game to the address shown. Keep this window open while you play."))
	fmt.Println(dim("  Type status, logout, uninstall or quit and press Enter."))
	fmt.Println()
}

/* ------------------------------------------------------------ uninstall -- */

func doUninstall(cfg *config, d *dialer, saved savedState, exe string, confirm func() bool) int {
	fmt.Println()
	warnf("This signs you out and removes every saved login and setting GamePanel Bridge keeps on this computer, then deletes this program.")
	if isTerminal() {
		fmt.Print("  Type YES and press Enter to continue: ")
		if !confirm() {
			infof("Cancelled.")
			return 1
		}
	}
	if saved.Token != "" {
		if _, err := d.call(map[string]any{"op": "logout", "token": saved.Token}); err != nil {
			warnf("Could not tell the panel (%v); the administrator can remove this device from the panel.", err)
		}
	}
	if err := removeAllData(); err != nil {
		errorf("Could not remove %s: %v", dataDir(), err)
		return 1
	}
	if err := removeSelf(exe); err != nil {
		warnf("Delete %s yourself to finish (%v).", exe, err)
	} else {
		okf("GamePanel Bridge was removed from this computer.")
	}
	return 0
}

/* -------------------------------------------------------------- output -- */

var color = false

func banner(cfg *config) {
	fmt.Println()
	fmt.Printf("  %s  %s\n", accent("GamePanel Bridge"), dim("v"+version))
	fmt.Printf("  %s · %s\n", cfg.Panel, cfg.User)
}

func paint(code, s string) string {
	if !color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func accent(s string) string { return paint("38;2;198;244;50", s) }
func dim(s string) string    { return paint("2", s) }
func bold(s string) string   { return paint("1", s) }

func infof(f string, a ...any) { fmt.Printf("  "+f+"\n", a...) }
func okf(f string, a ...any)   { fmt.Printf("  %s "+f+"\n", append([]any{accent("✓")}, a...)...) }
func warnf(f string, a ...any) { fmt.Printf("  %s "+f+"\n", append([]any{paint("33", "!")}, a...)...) }
func errorf(f string, a ...any) {
	fmt.Printf("  %s "+f+"\n", append([]any{paint("31", "✗")}, a...)...)
}

// restoreOnInterrupt runs undo when the returned func is called, or right
// away if Ctrl+C arrives first (so a hidden-input prompt never leaves the
// terminal without echo).
func restoreOnInterrupt(undo func()) func() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		select {
		case <-ch:
			once.Do(undo)
			fmt.Println()
			os.Exit(130)
		case <-stop:
		}
	}()
	return func() {
		signal.Stop(ch)
		close(stop)
		once.Do(undo)
	}
}
