package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liangzh77/fleeting/internal/auth"
)

func TestTimezoneAndCalendarBoundaries(t *testing.T) {
	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	losAngeles, _ := time.LoadLocation("America/Los_Angeles")
	cases := []struct {
		value    string
		location string
		want     string
	}{
		{"2026-10-06T15:59:59Z", "Asia/Shanghai", "2026-10-06"},
		{"2026-10-06T16:00:00Z", "Asia/Shanghai", "2026-10-07"},
		{"2026-10-07T00:00:00Z", "America/Los_Angeles", "2026-10-06"},
	}
	for _, item := range cases {
		location := shanghai
		if item.location == "America/Los_Angeles" {
			location = losAngeles
		}
		parsed, err := time.Parse(time.RFC3339, item.value)
		if err != nil {
			t.Fatal(err)
		}
		if got := LocalDate(parsed, location); got != item.want {
			t.Errorf("LocalDate(%s, %s)=%s want %s", item.value, item.location, got, item.want)
		}
	}
}

func TestValidDayAndMonth(t *testing.T) {
	if ValidDay("2026-02-30") {
		t.Error("2026-02-30 must be invalid")
	}
	if !ValidDay("2024-02-29") {
		t.Error("2024-02-29 must be valid")
	}
	if ValidDay("2026-2-3") || ValidDay("") {
		t.Error("bad day accepted")
	}
	if !ValidMonth("2026-10") || ValidMonth("2026-13") || ValidMonth("2026-1") {
		t.Error("month validation mismatch")
	}
	if Yesterday("2026-01-01") != "2025-12-31" ||
		Yesterday("2024-03-01") != "2024-02-29" ||
		Yesterday("2026-03-01") != "2026-02-28" {
		t.Error("yesterday boundary mismatch")
	}
}

func TestParseExtraBody(t *testing.T) {
	if body, err := ParseExtraBody(""); err != nil || body != nil {
		t.Fatalf("empty: %v %v", body, err)
	}
	body, err := ParseExtraBody(`{"enable_thinking":false,"reasoning_effort":"low"}`)
	if err != nil || body["enable_thinking"] != false {
		t.Fatalf("valid body: %v %v", body, err)
	}
	bad := []string{
		"not-json", "[]", "null", "false",
		`{"x":"` + strings.Repeat("x", 2000) + `"}`,
	}
	for _, key := range []string{"model", "messages", "stream", "tools", "tool_choice", "response_format", "max_tokens", "max_completion_tokens", "__proto__", "constructor", "prototype"} {
		bad = append(bad, `{"`+key+`":false}`)
	}
	for _, value := range bad {
		if _, err := ParseExtraBody(value); err == nil {
			t.Errorf("accepted invalid extra body: %s", value)
		}
	}
}

func TestLoadConfigPrecedenceAndValidation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	file := map[string]any{
		"origin":       "http://localhost:3000",
		"timezone":     "Asia/Shanghai",
		"database":     filepath.Join(dir, "db.sqlite"),
		"passwordHash": "scrypt:0123456789abcdef0123456789abcdef:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		"llm": map[string]any{
			"baseUrl":         "https://example.invalid/v1",
			"apiKey":          "key",
			"model":           "model",
			"reasoningEffort": "off",
			"extraBody":       `{"thinking":{"type":"disabled"}}`,
		},
	}
	encoded, _ := json.Marshal(file)
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FLEETING_CONFIG", path)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Origin != "http://localhost:3000" || cfg.LLM.ReasoningEffort != "off" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	if cfg.LLM.ExtraBody["thinking"] == nil {
		t.Fatal("extraBody not parsed")
	}
	t.Setenv("LLM_REASONING_EFFORT", "")
	t.Setenv("LLM_EXTRA_BODY", "")
	cfg, err = Load()
	if err != nil || cfg.LLM.ReasoningEffort != "" || cfg.LLM.ExtraBody != nil {
		t.Fatalf("empty env override failed: %+v %v", cfg, err)
	}
	for _, origin := range []string{"https://example.com/", "https://example.com/path", "http://example.com", "ftp://localhost"} {
		file["origin"] = origin
		encoded, _ = json.Marshal(file)
		_ = os.WriteFile(path, encoded, 0o600)
		if _, err := Load(); err == nil {
			t.Errorf("origin %q should be rejected", origin)
		}
	}
}

func TestMigratePassword(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	raw := `{"origin":"http://localhost:3000","password":"one-time-pass","llm":{"model":"m"}}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := MigratePassword(path)
	if err != nil || !changed {
		t.Fatalf("migrate: %v %v", changed, err)
	}
	content, _ := os.ReadFile(path)
	if strings.Contains(string(content), "one-time-pass") {
		t.Fatal("plaintext password still present")
	}
	var file map[string]any
	if err := json.Unmarshal(content, &file); err != nil {
		t.Fatal(err)
	}
	hash, _ := file["passwordHash"].(string)
	if !auth.VerifyPassword("one-time-pass", hash) {
		t.Fatal("migrated hash does not verify")
	}
	if _, ok := file["password"]; ok {
		t.Fatal("password key not removed")
	}
	if !strings.HasSuffix(string(content), "\n") {
		t.Fatal("missing trailing newline")
	}
	info, _ := os.Stat(path)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions %o", info.Mode().Perm())
	}
	t.Setenv("PASSWORD_HASH", "scrypt:...")
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := MigratePassword(path); err == nil {
		t.Fatal("PASSWORD_HASH + file password must fail")
	}
}
