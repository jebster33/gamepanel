//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func setupConsole() {
	color = isTerminal() && os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
}

func setTitle(title string) {
	if isTerminal() {
		fmt.Printf("\x1b]0;%s\x07", title)
	}
}

func isTerminal() bool {
	st, err := os.Stdin.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func pauseIfOwnWindow() {}

func stty(args ...string) error {
	cmd := exec.Command("stty", args...)
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

func readPassword(prompt string) (string, error) {
	fmt.Print(prompt)
	hidden := isTerminal() && stty("-echo") == nil
	if hidden {
		defer restoreOnInterrupt(func() { stty("echo") })()
	}
	line, err := stdin.ReadString('\n')
	if hidden {
		fmt.Println()
	}
	if err != nil && line == "" {
		return "", errors.New("no input")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// The saved file is mode 0600 in the user's own config directory.
func protect(plain []byte) ([]byte, error)    { return plain, nil }
func unprotect(sealed []byte) ([]byte, error) { return sealed, nil }

func removeSelf(exe string) error { return os.Remove(exe) }
