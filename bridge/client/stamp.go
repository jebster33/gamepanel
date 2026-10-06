package main

// The panel personalises every download by appending a trailer to this
// executable:  [JSON][uint32 little-endian JSON length]["GPBRIDG1"]

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
)

var stampMagic = []byte("GPBRIDG1")

type config struct {
	V     int      `json:"v"`
	Panel string   `json:"panel"`
	URLs  []string `json:"urls"`
	Pin   string   `json:"pin"`
	Conn  string   `json:"conn"`
	Key   string   `json:"key"`
	User  string   `json:"user"`
}

var errNoStamp = errors.New("this copy of GamePanel Bridge is not linked to a panel. Download your personal copy from the panel's Connections page")

func readStamp(path string) (*config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	if size < 12 {
		return nil, errNoStamp
	}
	tail := make([]byte, 12)
	if _, err := f.ReadAt(tail, size-12); err != nil {
		return nil, err
	}
	if !bytes.Equal(tail[4:], stampMagic) {
		return nil, errNoStamp
	}
	n := int64(binary.LittleEndian.Uint32(tail[:4]))
	if n <= 0 || n > 64<<10 || n > size-12 {
		return nil, errNoStamp
	}
	body := make([]byte, n)
	if _, err := f.ReadAt(body, size-12-n); err != nil && err != io.EOF {
		return nil, err
	}
	var cfg config
	if err := json.Unmarshal(body, &cfg); err != nil || cfg.V != 1 || cfg.Conn == "" || cfg.Key == "" || cfg.Pin == "" || len(cfg.URLs) == 0 {
		return nil, errors.New("this download is damaged; get a new copy from the panel")
	}
	return &cfg, nil
}
