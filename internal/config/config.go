// Package config loads the private JSON configuration and applies environment
// overrides with the same precedence as the previous Node.js release.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/liangzh77/fleeting/internal/auth"
	"github.com/liangzh77/fleeting/internal/jsonutil"
	"github.com/liangzh77/fleeting/internal/textutil"
)

// LLM holds the OpenAI-compatible provider settings. Empty fields disable AI.
type LLM struct {
	BaseURL         string
	APIKey          string
	Model           string
	ReasoningEffort string
	ExtraBody       map[string]any
}

// Config is the effective runtime configuration.
type Config struct {
	Origin       string
	Timezone     string
	Database     string
	PasswordHash string
	LLM          LLM
}

// Private mirrors the optional private JSON file.
type Private struct {
	Origin       string
	Timezone     string
	Database     string
	PasswordHash string
	Password     string
	HasPassword  bool
	LLM          LLMPrivate
	Raw          map[string]json.RawMessage
}

// LLMPrivate is the file representation of the llm object. extraBody stays a
// string in the file so configuration errors can be reported clearly.
type LLMPrivate struct {
	BaseURL         string
	APIKey          string
	Model           string
	ReasoningEffort string
	ExtraBody       string
}

var (
	dayPattern   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	monthPattern = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)
)

// Path returns the private configuration path.
func Path() string {
	if p := os.Getenv("FLEETING_CONFIG"); p != "" {
		return p
	}
	return "config.local.json"
}

// ReadPrivate loads and type-checks the private configuration. Error messages
// never include file contents, which may hold credentials.
func ReadPrivate(path string) (*Private, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
	}
	p := &Private{Raw: fields}
	for _, item := range []struct {
		key    string
		target *string
	}{
		{"origin", &p.Origin},
		{"timezone", &p.Timezone},
		{"database", &p.Database},
		{"passwordHash", &p.PasswordHash},
		{"password", &p.Password},
	} {
		if value, ok := fields[item.key]; ok {
			if err := json.Unmarshal(value, item.target); err != nil {
				return nil, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
			}
		}
	}
	_, p.HasPassword = fields["password"]
	if value, ok := fields["llm"]; ok {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
		}
		var llm map[string]json.RawMessage
		if err := json.Unmarshal(value, &llm); err != nil || llm == nil {
			return nil, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
		}
		for _, item := range []struct {
			key    string
			target *string
		}{
			{"baseUrl", &p.LLM.BaseURL},
			{"apiKey", &p.LLM.APIKey},
			{"model", &p.LLM.Model},
			{"reasoningEffort", &p.LLM.ReasoningEffort},
			{"extraBody", &p.LLM.ExtraBody},
		} {
			if value, ok := llm[item.key]; ok {
				if err := json.Unmarshal(value, item.target); err != nil {
					return nil, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
				}
			}
		}
	}
	return p, nil
}

func readPrivateIfExists(path string) (*Private, bool, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
	}
	p, err := ReadPrivate(path)
	if err != nil {
		return nil, false, errors.New("私有配置读取失败，请检查文件权限、JSON 格式及字段类型")
	}
	return p, true, nil
}

// MigratePassword turns a one-time plaintext "password" into "passwordHash"
// before the server starts listening. It returns true when the file changed.
func MigratePassword(path string) (bool, error) {
	p, exists, err := readPrivateIfExists(path)
	if err != nil {
		return false, err
	}
	if !exists || !p.HasPassword {
		return false, nil
	}
	if os.Getenv("PASSWORD_HASH") != "" {
		return false, errors.New("设置了 PASSWORD_HASH 环境变量，请先移除它再使用配置文件的 password")
	}
	hash, err := auth.HashPassword(p.Password)
	if err != nil {
		return false, err
	}
	delete(p.Raw, "password")
	encodedHash, err := json.Marshal(hash)
	if err != nil {
		return false, errors.New("密码哈希写入私有配置失败；服务未启动，请检查文件权限")
	}
	p.Raw["passwordHash"] = encodedHash
	content, err := json.MarshalIndent(p.Raw, "", "  ")
	if err != nil {
		return false, errors.New("密码哈希写入私有配置失败；服务未启动，请检查文件权限")
	}
	content = append(content, '\n')
	temporary := fmt.Sprintf("%s.%s.tmp", path, randomSuffix())
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return false, errors.New("密码哈希写入私有配置失败；服务未启动，请检查文件权限")
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return false, errors.New("密码哈希写入私有配置失败；服务未启动，请检查文件权限")
	}
	if err := file.Close(); err != nil {
		return false, errors.New("密码哈希写入私有配置失败；服务未启动，请检查文件权限")
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		return false, errors.New("密码哈希写入私有配置失败；服务未启动，请检查文件权限")
	}
	if err := os.Rename(temporary, path); err != nil {
		return false, errors.New("密码哈希写入私有配置失败；服务未启动，请检查文件权限")
	}
	ok = true
	return true, nil
}

func randomSuffix() string {
	token, err := auth.Token()
	if err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return token[:16]
}

// Load builds the effective configuration. It validates the origin, timezone
// and optional extra request body before the server listens.
func Load() (Config, error) {
	path := Path()
	private, exists, err := readPrivateIfExists(path)
	if err != nil {
		return Config{}, err
	}
	if !exists {
		private = &Private{}
	}
	envOr := func(key, fallback string) string {
		if value := os.Getenv(key); value != "" {
			return value
		}
		return fallback
	}
	envValue := func(key, fallback string) string {
		if value, ok := os.LookupEnv(key); ok {
			return value
		}
		return fallback
	}
	c := Config{
		Origin:       envOr("APP_ORIGIN", firstNonEmpty(private.Origin, "http://localhost:3000")),
		Timezone:     envOr("APP_TIMEZONE", firstNonEmpty(private.Timezone, "Asia/Shanghai")),
		Database:     envOr("DATABASE_PATH", firstNonEmpty(private.Database, "./data/fleeting.sqlite")),
		PasswordHash: envOr("PASSWORD_HASH", private.PasswordHash),
		LLM: LLM{
			BaseURL:         envOr("LLM_BASE_URL", private.LLM.BaseURL),
			APIKey:          envOr("LLM_API_KEY", private.LLM.APIKey),
			Model:           envOr("LLM_MODEL", private.LLM.Model),
			ReasoningEffort: envValue("LLM_REASONING_EFFORT", private.LLM.ReasoningEffort),
		},
	}
	extra := envValue("LLM_EXTRA_BODY", private.LLM.ExtraBody)
	c.LLM.ExtraBody, err = ParseExtraBody(extra)
	if err != nil {
		return Config{}, err
	}
	if err := validateOrigin(c.Origin); err != nil {
		return Config{}, err
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		return Config{}, errors.New("APP_TIMEZONE 必须是有效的 IANA 时区")
	}
	return c, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func validateOrigin(origin string) error {
	bad := errors.New("APP_ORIGIN 必须是无路径的 HTTP(S) origin")
	parsed, err := parseOrigin(origin)
	if err != nil {
		return bad
	}
	if parsed.scheme+"://"+parsed.host != origin {
		return bad
	}
	if parsed.scheme != "https" {
		switch parsed.hostname {
		case "localhost", "127.0.0.1", "::1", "[::1]":
		default:
			return errors.New("非本机部署必须 HTTPS")
		}
	}
	return nil
}

type originParts struct {
	scheme   string
	host     string
	hostname string
}

func parseOrigin(origin string) (originParts, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return originParts{}, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return originParts{}, errors.New("unsupported scheme")
	}
	if u.Host == "" || u.Opaque != "" || u.User != nil {
		return originParts{}, errors.New("invalid origin")
	}
	return originParts{scheme: u.Scheme, host: u.Host, hostname: u.Hostname()}, nil
}

// ParseExtraBody validates LLM_EXTRA_BODY / llm.extraBody.
func ParseExtraBody(value string) (map[string]any, error) {
	failure := errors.New("LLM_EXTRA_BODY / llm.extraBody 必须是最多2000字符的 JSON 对象，且不能覆盖程序自有字段")
	if value == "" {
		return nil, nil
	}
	if textutil.Len(value) > 2000 {
		return nil, failure
	}
	var body any
	if err := jsonutil.Decode([]byte(value), &body); err != nil {
		return nil, failure
	}
	object, ok := body.(map[string]any)
	if !ok || object == nil {
		return nil, failure
	}
	forbidden := map[string]bool{
		"model": true, "messages": true, "stream": true, "tools": true,
		"tool_choice": true, "response_format": true, "max_tokens": true,
		"max_completion_tokens": true, "__proto__": true, "constructor": true,
		"prototype": true,
	}
	for key := range object {
		if forbidden[key] {
			return nil, failure
		}
	}
	if length, err := jsonutil.Len(object); err != nil || length > 2000 {
		return nil, failure
	}
	return object, nil
}

// Location returns the configured IANA location. Load has already validated it.
func (c Config) Location() *time.Location {
	location, err := time.LoadLocation(c.Timezone)
	if err != nil {
		return time.UTC
	}
	return location
}

// LocalDate formats the calendar day of t in location.
func LocalDate(t time.Time, location *time.Location) string {
	return t.In(location).Format("2006-01-02")
}

// FormatISO matches JavaScript Date.prototype.toISOString() for millisecond
// precision.
func FormatISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// TodayString is the calendar date in the configured timezone.
func TodayString(now time.Time, location *time.Location) string {
	return LocalDate(now, location)
}

// ValidDay reports whether s is a real YYYY-MM-DD calendar date.
func ValidDay(s string) bool {
	if !dayPattern.MatchString(s) {
		return false
	}
	parsed, err := time.Parse("2006-01-02", s)
	if err != nil {
		return false
	}
	return parsed.Format("2006-01-02") == s
}

// ValidMonth reports whether s is YYYY-MM.
func ValidMonth(s string) bool {
	return monthPattern.MatchString(s)
}

// Yesterday returns the previous calendar date. It deliberately operates on
// the date string in UTC, like the old scheduler's calendar arithmetic.
func Yesterday(day string) string {
	parsed, err := time.Parse("2006-01-02", day)
	if err != nil {
		return ""
	}
	return parsed.AddDate(0, 0, -1).Format("2006-01-02")
}

// EnsureDatabaseDir creates the parent directory of a SQLite file with 0700.
func EnsureDatabaseDir(path string) error {
	if path == ":memory:" || path == "" {
		return nil
	}
	return os.MkdirAll(filepath.Dir(path), 0o700)
}
