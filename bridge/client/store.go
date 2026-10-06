package main

// The saved login: a device token (never the password) and the address that
// last worked, one small file per panel+account. On Windows the file is
// encrypted with DPAPI, so only this Windows account can read it; elsewhere it
// is readable by the owner only.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
)

type savedState struct {
	Token string `json:"token"`
	URL   string `json:"url"`
}

func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "GamePanel Bridge")
}

func stateFile(cfg *config) string {
	sum := sha256.Sum256([]byte(cfg.Pin + "|" + cfg.Conn))
	return filepath.Join(dataDir(), hex.EncodeToString(sum[:12])+".dat")
}

func loadSaved(cfg *config) savedState {
	var s savedState
	raw, err := os.ReadFile(stateFile(cfg))
	if err != nil {
		return s
	}
	plain, err := unprotect(raw)
	if err != nil {
		return s
	}
	json.Unmarshal(plain, &s)
	return s
}

func saveState(cfg *config, s *savedState, d *dialer, token string) {
	s.Token = token
	s.URL = d.preferred()
	plain, _ := json.Marshal(s)
	sealed, err := protect(plain)
	if err != nil {
		warnf("Could not protect the saved login (%v); you will be asked to sign in next time.", err)
		return
	}
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return
	}
	file := stateFile(cfg)
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, sealed, 0o600); err != nil {
		return
	}
	os.Rename(tmp, file)
}

func forget(cfg *config) {
	os.Remove(stateFile(cfg))
}

func removeAllData() error {
	return os.RemoveAll(dataDir())
}
