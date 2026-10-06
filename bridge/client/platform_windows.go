package main

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	crypt32                = syscall.NewLazyDLL("crypt32.dll")
	procGetConsoleMode     = kernel32.NewProc("GetConsoleMode")
	procSetConsoleMode     = kernel32.NewProc("SetConsoleMode")
	procSetConsoleTitleW   = kernel32.NewProc("SetConsoleTitleW")
	procGetConsoleProcList = kernel32.NewProc("GetConsoleProcessList")
	procLocalFree          = kernel32.NewProc("LocalFree")
	procProtect            = crypt32.NewProc("CryptProtectData")
	procUnprotect          = crypt32.NewProc("CryptUnprotectData")
)

const (
	enableEchoInput    = 0x0004
	enableVTProcessing = 0x0004
	cryptUIForbidden   = 0x1
)

func consoleMode(h syscall.Handle) (uint32, bool) {
	var mode uint32
	r, _, _ := procGetConsoleMode.Call(uintptr(h), uintptr(unsafe.Pointer(&mode)))
	return mode, r != 0
}

func setupConsole() {
	if mode, ok := consoleMode(syscall.Stdout); ok {
		r, _, _ := procSetConsoleMode.Call(uintptr(syscall.Stdout), uintptr(mode|enableVTProcessing))
		color = r != 0
	}
}

func setTitle(title string) {
	p, err := syscall.UTF16PtrFromString(title)
	if err == nil {
		procSetConsoleTitleW.Call(uintptr(unsafe.Pointer(p)))
	}
}

func isTerminal() bool {
	_, ok := consoleMode(syscall.Stdin)
	return ok
}

// pauseIfOwnWindow keeps a double-clicked window open long enough to read
// the last message. Started from a terminal, nothing waits.
func pauseIfOwnWindow() {
	var list [4]uint32
	n, _, _ := procGetConsoleProcList.Call(uintptr(unsafe.Pointer(&list[0])), 4)
	if n == 1 && isTerminal() {
		fmt.Print("\n  Press Enter to close this window.")
		stdin.ReadString('\n')
	}
}

func readPassword(prompt string) (string, error) {
	fmt.Print(prompt)
	mode, ok := consoleMode(syscall.Stdin)
	if ok {
		procSetConsoleMode.Call(uintptr(syscall.Stdin), uintptr(mode&^enableEchoInput))
		defer restoreOnInterrupt(func() { procSetConsoleMode.Call(uintptr(syscall.Stdin), uintptr(mode)) })()
	}
	line, err := stdin.ReadString('\n')
	if ok {
		fmt.Println()
	}
	if err != nil && line == "" {
		return "", errors.New("no input")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

type dataBlob struct {
	size uint32
	data *byte
}

func blob(b []byte) *dataBlob {
	if len(b) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{size: uint32(len(b)), data: &b[0]}
}

func (b *dataBlob) bytes() []byte {
	out := make([]byte, b.size)
	copy(out, unsafe.Slice(b.data, b.size))
	return out
}

// protect encrypts with DPAPI, bound to the current Windows user.
func protect(plain []byte) ([]byte, error) {
	var out dataBlob
	r, _, err := procProtect.Call(uintptr(unsafe.Pointer(blob(plain))), 0, 0, 0, 0, cryptUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.data)))
	return out.bytes(), nil
}

func unprotect(sealed []byte) ([]byte, error) {
	var out dataBlob
	r, _, err := procUnprotect.Call(uintptr(unsafe.Pointer(blob(sealed))), 0, 0, 0, 0, cryptUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.data)))
	return out.bytes(), nil
}

// removeSelf deletes the running .exe once it has exited.
func removeSelf(exe string) error {
	// cmd.exe does not understand Go's \" argument escaping, so the command
	// line is written out as cmd expects it.
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008, // DETACHED_PROCESS
		CmdLine:       `cmd.exe /D /C "ping 127.0.0.1 -n 3 >nul & del /f /q "` + exe + `""`,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
