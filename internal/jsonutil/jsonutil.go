// Package jsonutil centralizes JSON encoding choices that must match the
// previous Node.js implementation.
package jsonutil

import (
	"bytes"
	"encoding/json"

	"github.com/liangzh77/fleeting/internal/textutil"
)

// Marshal encodes v like JSON.stringify: compact, UTF-8 preserved, and with
// HTML characters left alone (Go's default encoder escapes <, > and &).
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	out := buf.Bytes()
	// Encoder.Encode always appends a newline.
	if len(out) > 0 && out[len(out)-1] == '\n' {
		out = out[:len(out)-1]
	}
	return out, nil
}

// Len returns the UTF-16 length of JSON.stringify(v), which the old code used
// as its material and output budget.
func Len(v any) (int, error) {
	b, err := Marshal(v)
	if err != nil {
		return 0, err
	}
	return textutil.Len(string(b)), nil
}

// Decode parses a JSON document while keeping numbers exact.
func Decode(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return dec.Decode(v)
}
