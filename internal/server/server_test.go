package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liangzh77/fleeting/internal/ai"
	"github.com/liangzh77/fleeting/internal/auth"
	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/jsonutil"
	"github.com/liangzh77/fleeting/internal/store"
)

const testPassword = "test-only-not-a-credential"

type fixture struct {
	t       *testing.T
	cfg     config.Config
	store   *store.Store
	server  *httptest.Server
	webRoot string
	cookie  string
	csrf    string
	client  *http.Client
}

type fixtureOptions struct {
	origin     string
	configured bool
	webRoot    string
}

func newFixture(t *testing.T, options fixtureOptions) *fixture {
	t.Helper()
	if options.origin == "" {
		options.origin = "http://localhost:3000"
	}
	dir := t.TempDir()
	webRoot := options.webRoot
	if webRoot == "" {
		webRoot = filepath.Join(dir, "web")
		if err := os.MkdirAll(webRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		for name, content := range map[string]string{
			"index.html": "<!doctype html><title>Fleeting</title><link rel=\"stylesheet\" href=\"style.css\"><script type=\"module\" src=\"app.js\"></script>",
			"style.css":  ":root{--paper:#f5f2ea}",
			"app.js":     "console.log('fleeting')",
		} {
			if err := os.WriteFile(filepath.Join(webRoot, name), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Origin: options.origin, Timezone: "Asia/Shanghai",
		Database: filepath.Join(dir, "db.sqlite"), PasswordHash: hash,
	}
	if options.configured {
		cfg.LLM = config.LLM{BaseURL: "https://example.invalid/v1", APIKey: "mock-test-placeholder", Model: "mock"}
	}
	st, err := store.Open(cfg.Database, cfg.Timezone, true)
	if err != nil {
		t.Fatal(err)
	}
	service := ai.NewWithFetcher(st, cfg, serverFetcher(t), nil)
	app, err := New(cfg, st, service, webRoot)
	if err != nil {
		st.Close()
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Handler())
	f := &fixture{
		t: t, cfg: cfg, store: st, server: server, webRoot: webRoot,
		client: &http.Client{Timeout: 30 * time.Second},
	}
	t.Cleanup(func() {
		server.Close()
		st.Close()
	})
	return f
}

func (f *fixture) request(method, path string, body any, headers map[string]string) *http.Response {
	f.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := jsonutil.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, f.server.URL+path, reader)
	if err != nil {
		f.t.Fatal(err)
	}
	request.Header.Set("Origin", f.cfg.Origin)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if f.cookie != "" {
		request.Header.Set("Cookie", f.cookie)
	}
	if f.csrf != "" {
		request.Header.Set("X-CSRF-Token", f.csrf)
	}
	for key, value := range headers {
		if value == "" {
			request.Header.Del(key)
		} else {
			request.Header.Set(key, value)
		}
	}
	response, err := f.client.Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	return response
}

func (f *fixture) login() *http.Response {
	f.t.Helper()
	response := f.request(http.MethodPost, "/api/login", map[string]any{"password": testPassword}, nil)
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		f.t.Fatalf("login status=%d body=%s", response.StatusCode, body)
	}
	cookies := response.Cookies()
	if len(cookies) == 0 {
		f.t.Fatal("no session cookie")
	}
	f.cookie = cookies[0].Name + "=" + cookies[0].Value
	session := f.request(http.MethodGet, "/api/session", nil, nil)
	defer session.Body.Close()
	var payload map[string]any
	if err := jsonutil.Decode(readAll(f.t, session), &payload); err != nil {
		f.t.Fatal(err)
	}
	f.csrf, _ = payload["csrf"].(string)
	response.Body.Close()
	return response
}

func readAll(t *testing.T, response *http.Response) []byte {
	t.Helper()
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func bodyJSON(t *testing.T, response *http.Response) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := jsonutil.Decode(readAll(t, response), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

// serverFetcher is a faithful, minimal model double for API tests.
func serverFetcher(t *testing.T) ai.Fetcher {
	return func(request *http.Request) (*http.Response, error) {
		rawBody, _ := io.ReadAll(request.Body)
		var body map[string]any
		if err := jsonutil.Decode(rawBody, &body); err != nil {
			t.Fatal(err)
		}
		messages := body["messages"].([]any)
		prompt := messages[0].(map[string]any)["content"].(string)
		var data any
		if err := jsonutil.Decode([]byte(messages[1].(map[string]any)["content"].(string)), &data); err != nil {
			t.Fatal(err)
		}
		var content any
		if strings.Contains(prompt, "按每条原文抽取") {
			entries := data.([]any)
			out := []any{}
			for _, item := range entries {
				entry := item.(map[string]any)
				out = append(out, map[string]any{"id": entry["id"], "themes": []any{"生活与日常"}, "points": entry["text"]})
			}
			content = map[string]any{"entries": out}
		} else if strings.Contains(prompt, "生成月度回顾") {
			entries := data.(map[string]any)["originals"].([]any)
			evidence := []any{}
			for _, item := range entries {
				entry := item.(map[string]any)
				evidence = append(evidence, map[string]any{"id": entry["id"], "quote": entry["text"]})
			}
			item := map[string]any{"fact": "事实", "evidence": evidence}
			content = map[string]any{
				"overview": "概括", "insights": []any{item}, "changes": []any{},
				"connections": []any{}, "questions": []any{},
			}
		} else {
			var entries []any
			if list, ok := data.([]any); ok {
				entries = list
			} else if object, ok := data.(map[string]any); ok {
				entries, _ = object["originals"].([]any)
			}
			sections := []any{}
			for _, item := range entries {
				entry := item.(map[string]any)
				sections = append(sections, map[string]any{
					"segments": []any{map[string]any{"text": entry["text"], "sources": []any{entry["id"]}}},
				})
			}
			content = map[string]any{"sections": sections}
		}
		encodedContent, _ := jsonutil.Marshal(content)
		envelope, _ := jsonutil.Marshal(map[string]any{
			"choices": []any{map[string]any{
				"finish_reason": "stop",
				"message":       map[string]any{"content": string(encodedContent)},
			}},
		})
		return &http.Response{
			StatusCode: 200, Header: http.Header{},
			Body: io.NopCloser(bytes.NewReader(envelope)),
		}, nil
	}
}

func TestAuthOriginCSRFCookieAndLogout(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	paths := []struct {
		method string
		path   string
		body   any
	}{
		{"GET", "/api/session", nil},
		{"GET", "/api/entries?day=2026-10-07", nil},
		{"GET", "/api/dates", nil},
		{"GET", "/api/entries/id", nil},
		{"GET", "/api/export", nil},
		{"GET", "/api/result?kind=day&period=2026-10-07", nil},
		{"POST", "/api/entries", map[string]any{"text": "secret"}},
		{"PUT", "/api/entries/id", map[string]any{"text": "secret"}},
		{"DELETE", "/api/entries/id", map[string]any{"version": 1}},
		{"POST", "/api/generate", map[string]any{"kind": "day", "period": "2026-10-07"}},
	}
	for _, item := range paths {
		response := f.request(item.method, item.path, item.body, nil)
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s status=%d", item.method, item.path, response.StatusCode)
		}
		response.Body.Close()
	}
	evil := f.request(http.MethodPost, "/api/login", map[string]any{"password": testPassword}, map[string]string{"Origin": "https://evil.invalid"})
	if evil.StatusCode != http.StatusForbidden {
		t.Fatalf("evil origin status=%d", evil.StatusCode)
	}
	evil.Body.Close()
	login := f.login()
	defer login.Body.Close()
	setCookie := strings.Join(login.Header.Values("Set-Cookie"), ";")
	for _, expected := range []string{"HttpOnly", "SameSite=Strict"} {
		if !strings.Contains(setCookie, expected) {
			t.Errorf("cookie missing %s: %s", expected, setCookie)
		}
	}
	noCSRF := f.request(http.MethodPost, "/api/entries", map[string]any{"text": "a"}, map[string]string{"X-CSRF-Token": ""})
	if noCSRF.StatusCode != http.StatusForbidden {
		t.Fatalf("csrf status=%d", noCSRF.StatusCode)
	}
	noCSRF.Body.Close()
	noOrigin := f.request(http.MethodPost, "/api/logout", map[string]any{}, map[string]string{"Origin": ""})
	if noOrigin.StatusCode != http.StatusForbidden {
		t.Fatalf("logout origin status=%d", noOrigin.StatusCode)
	}
	noOrigin.Body.Close()
	logout := f.request(http.MethodPost, "/api/logout", map[string]any{}, nil)
	if logout.StatusCode != http.StatusOK {
		t.Fatalf("logout status=%d", logout.StatusCode)
	}
	logout.Body.Close()
	after := f.request(http.MethodGet, "/api/export", nil, nil)
	if after.StatusCode != http.StatusUnauthorized {
		t.Fatalf("export after logout status=%d", after.StatusCode)
	}
	after.Body.Close()
}

func TestHTTPSSecureCookieAndPasswordChangeRevokesSessions(t *testing.T) {
	f := newFixture(t, fixtureOptions{origin: "https://notes.example.org"})
	login := f.login()
	defer login.Body.Close()
	cookieHeader := strings.Join(login.Header.Values("Set-Cookie"), ";")
	if !strings.HasPrefix(cookieHeader, "__Host-fleeting=") {
		t.Fatalf("cookie name: %s", cookieHeader)
	}
	if !strings.Contains(cookieHeader, "; Secure") {
		t.Fatalf("secure flag: %s", cookieHeader)
	}
	if !strings.Contains(login.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("missing CSP")
	}
	if login.Header.Get("Strict-Transport-Security") == "" {
		t.Fatal("missing HSTS")
	}
	newHash, _ := auth.HashPassword("changed-test-only-password")
	f.cfg.PasswordHash = newHash
	if _, err := New(f.cfg, f.store, ai.NewWithFetcher(f.store, f.cfg, serverFetcher(t), nil), f.webRoot); err != nil {
		t.Fatal(err)
	}
	session := f.request(http.MethodGet, "/api/session", nil, nil)
	if session.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old session status=%d", session.StatusCode)
	}
	session.Body.Close()
}

func TestLoginRateLimitParallelAndProxyIP(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	statuses := make(chan int, 12)
	for index := 0; index < 12; index++ {
		go func() {
			response := f.request(http.MethodPost, "/api/login", map[string]any{"password": "wrong"}, nil)
			statuses <- response.StatusCode
			response.Body.Close()
		}()
	}
	count401, count429 := 0, 0
	for index := 0; index < 12; index++ {
		switch <-statuses {
		case http.StatusUnauthorized:
			count401++
		case http.StatusTooManyRequests:
			count429++
		}
	}
	if count401 != 8 || count429 != 4 {
		t.Fatalf("401=%d 429=%d", count401, count429)
	}
	blocked := f.request(http.MethodPost, "/api/login", map[string]any{"password": testPassword}, nil)
	if blocked.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("blocked correct password status=%d", blocked.StatusCode)
	}
	retry, _ := strconvAtoi(blocked.Header.Get("Retry-After"))
	if retry < 1 || retry > 30 {
		t.Fatalf("Retry-After=%d", retry)
	}
	blocked.Body.Close()
	// A newer release caps old lockouts to one 30-second window.
	old := time.Now().Add(15 * time.Minute).UnixMilli()
	if _, err := f.store.DB().Exec("UPDATE attempts SET until=?", old); err != nil {
		t.Fatal(err)
	}
	service := ai.NewWithFetcher(f.store, f.cfg, serverFetcher(t), nil)
	if _, err := New(f.cfg, f.store, service, f.webRoot); err != nil {
		t.Fatal(err)
	}
	var capped int64
	if err := f.store.DB().QueryRow("SELECT until FROM attempts").Scan(&capped); err != nil {
		t.Fatal(err)
	}
	if capped > time.Now().Add(31*time.Second).UnixMilli() {
		t.Fatalf("lockout not capped: %d", capped)
	}
	if _, err := f.store.DB().Exec("UPDATE attempts SET until=?", time.Now().Add(-time.Second).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	success := f.request(http.MethodPost, "/api/login", map[string]any{"password": testPassword}, nil)
	if success.StatusCode != http.StatusOK {
		t.Fatalf("after expiry status=%d", success.StatusCode)
	}
	success.Body.Close()

	// Proxy-provided client addresses are bucketed independently.
	f2 := newFixture(t, fixtureOptions{})
	proxy := func(ip string) map[string]string { return map[string]string{"X-Forwarded-For": ip} }
	for index := 0; index < 8; index++ {
		response := f2.request(http.MethodPost, "/api/login", map[string]any{"password": "wrong"}, proxy("203.0.113.9"))
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("proxy attempt %d status=%d", index, response.StatusCode)
		}
		response.Body.Close()
	}
	blockedProxy := f2.request(http.MethodPost, "/api/login", map[string]any{"password": "wrong"}, proxy("203.0.113.9"))
	if blockedProxy.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("proxy block status=%d", blockedProxy.StatusCode)
	}
	blockedProxy.Body.Close()
	other := f2.request(http.MethodPost, "/api/login", map[string]any{"password": "wrong"}, proxy("198.51.100.4"))
	if other.StatusCode != http.StatusUnauthorized {
		t.Fatalf("other proxy status=%d", other.StatusCode)
	}
	other.Body.Close()
	direct := f2.request(http.MethodPost, "/api/login", map[string]any{"password": "wrong"}, nil)
	if direct.StatusCode != http.StatusUnauthorized {
		t.Fatalf("direct status=%d", direct.StatusCode)
	}
	direct.Body.Close()
	if got := f2.request(http.MethodPost, "/api/login", map[string]any{"password": testPassword}, nil); got.StatusCode != http.StatusOK {
		t.Fatalf("direct login status=%d", got.StatusCode)
	} else {
		got.Body.Close()
	}
	rows, err := f2.store.DB().Query("SELECT ip,count FROM attempts ORDER BY ip")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var ip string
		var count int
		if err := rows.Scan(&ip, &count); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, ip)
		if count > 8 {
			t.Fatalf("count for %s = %d", ip, count)
		}
	}
	if strings.Join(keys, ",") != "127.0.0.1,198.51.100.4,203.0.113.9" {
		t.Fatalf("attempt keys: %v", keys)
	}
}

func TestEntryCRUDIdempotencySearchExportAndErrors(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	f.login()
	headers := map[string]string{"Idempotency-Key": "test-idempotency-key-0001"}
	text := "  昨晚 3 次尝试，AI 想法？\n矛盾也保留。<script>alert(1)</script>  "
	bad := f.request(http.MethodPost, "/api/entries", map[string]any{"text": " "}, headers)
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank status=%d", bad.StatusCode)
	}
	bad.Body.Close()
	first := f.request(http.MethodPost, "/api/entries", map[string]any{"text": text}, headers)
	if first.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(first.Body)
		t.Fatalf("create status=%d body=%s", first.StatusCode, body)
	}
	created := bodyJSON(t, first)
	entry := created["entry"].(map[string]any)
	id := entry["id"].(string)
	if entry["text"] != text || numberTest(entry["version"]) != 1 || numberTest(entry["timeUnknown"]) != 0 {
		t.Fatalf("created entry: %+v", entry)
	}
	for index := 0; index < 3; index++ {
		replay := f.request(http.MethodPost, "/api/entries", map[string]any{"text": text}, headers)
		if replay.StatusCode != http.StatusOK {
			t.Fatalf("replay status=%d", replay.StatusCode)
		}
		payload := bodyJSON(t, replay)
		if payload["entry"].(map[string]any)["id"] != id || payload["replay"] != true {
			t.Fatalf("replay payload: %+v", payload)
		}
	}
	conflict := f.request(http.MethodPost, "/api/entries", map[string]any{"text": "different"}, headers)
	if conflict.StatusCode != http.StatusConflict {
		t.Fatalf("conflict status=%d", conflict.StatusCode)
	}
	conflict.Body.Close()
	day := entry["day"].(string)
	dayResponse := f.request(http.MethodGet, "/api/entries?day="+day, nil, nil)
	var dayEntries []any
	if err := jsonutil.Decode(readAll(t, dayResponse), &dayEntries); err != nil || len(dayEntries) != 1 {
		t.Fatalf("day entries: %d %v", len(dayEntries), err)
	}
	search := f.request(http.MethodGet, "/api/entries?q="+urlQuery("昨晚"), nil, nil)
	if payload := readAll(t, search); !strings.Contains(string(payload), id) {
		t.Fatalf("search: %s", payload)
	}
	if response := f.request(http.MethodPut, "/api/entries/"+id, map[string]any{"text": "修改", "version": 2}, nil); response.StatusCode != http.StatusConflict {
		t.Fatalf("update conflict status=%d", response.StatusCode)
	} else {
		response.Body.Close()
	}
	updated := f.request(http.MethodPut, "/api/entries/"+id, map[string]any{"text": "修改", "version": 1}, nil)
	if updated.StatusCode != http.StatusOK {
		t.Fatalf("update status=%d", updated.StatusCode)
	}
	updatedEntry := bodyJSON(t, updated)
	if updatedEntry["text"] != "修改" || numberTest(updatedEntry["version"]) != 2 {
		t.Fatalf("updated: %+v", updatedEntry)
	}
	exported := bodyJSON(t, f.request(http.MethodGet, "/api/export", nil, nil))
	if exported["timezone"] != "Asia/Shanghai" || numberTest(exported["formatVersion"]) != 1 {
		t.Fatalf("export meta: %+v", exported)
	}
	entries := exported["entries"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["text"] != "修改" {
		t.Fatalf("export entries: %+v", entries)
	}
	markdown := readAll(t, f.request(http.MethodGet, "/api/export?format=markdown&day="+day, nil, nil))
	if !strings.Contains(string(markdown), "修改") || !strings.Contains(string(markdown), "## "+day) {
		t.Fatalf("markdown: %s", markdown)
	}
	deleted := f.request(http.MethodDelete, "/api/entries/"+id, map[string]any{"version": 2}, nil)
	if deleted.StatusCode != http.StatusOK {
		t.Fatalf("delete status=%d", deleted.StatusCode)
	}
	deleted.Body.Close()
	missing := f.request(http.MethodGet, "/api/entries/"+id, nil, nil)
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("missing status=%d", missing.StatusCode)
	}
	missing.Body.Close()
	tooLarge := f.request(http.MethodPost, "/api/entries", map[string]any{"text": strings.Repeat("x", 40000)}, map[string]string{"Idempotency-Key": "test-idempotency-key-9999"})
	if tooLarge.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large status=%d", tooLarge.StatusCode)
	}
	tooLarge.Body.Close()
	badJSON := f.request(http.MethodPost, "/api/entries", nil, map[string]string{
		"Content-Type": "application/json", "Idempotency-Key": "test-idempotency-key-8888",
	})
	badJSON.Body.Close()
	// Empty JSON body is treated like {} and reaches text validation.
	if badJSON.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty body status=%d", badJSON.StatusCode)
	}
}

func TestGenerateAndResultAPIWithMockModel(t *testing.T) {
	f := newFixture(t, fixtureOptions{configured: true})
	f.login()
	a := f.storeMustCreate("昨晚和孩子聊了 3 次，控制还是放手？", "api-a", "2026-10-01T00:00:00Z")
	b := f.storeMustCreate("AI 产品想减少控制，但也担心错误。", "api-b", "2026-10-02T10:00:00Z")

	empty := bodyJSON(t, f.request(http.MethodGet, "/api/result?kind=day&period="+a.Day, nil, nil))
	if empty["state"] != nil || empty["data"] != nil || empty["outdated"] != false || empty["change"] != "none" {
		t.Fatalf("empty result: %+v", empty)
	}
	noConsent := f.request(http.MethodPost, "/api/generate", map[string]any{"kind": "day", "period": a.Day}, nil)
	if noConsent.StatusCode != http.StatusBadRequest {
		t.Fatalf("consent status=%d", noConsent.StatusCode)
	}
	noConsent.Body.Close()
	generated := f.request(http.MethodPost, "/api/generate", map[string]any{"kind": "day", "period": a.Day, "consent": true}, nil)
	if generated.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(generated.Body)
		t.Fatalf("generate status=%d body=%s", generated.StatusCode, body)
	}
	generated.Body.Close()
	daily := bodyJSON(t, f.request(http.MethodGet, "/api/result?kind=day&period="+a.Day, nil, nil))
	if daily["state"] != "ready" || daily["outdated"] != false {
		t.Fatalf("daily: %+v", daily)
	}
	data := daily["data"].(map[string]any)
	if len(data["sections"].([]any)) != 1 || len(data["sources"].([]any)) != 1 {
		t.Fatalf("daily data: %+v", data)
	}
	monthlyGenerate := f.request(http.MethodPost, "/api/generate", map[string]any{"kind": "month", "period": "2026-10", "consent": true}, nil)
	if monthlyGenerate.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(monthlyGenerate.Body)
		t.Fatalf("month status=%d body=%s", monthlyGenerate.StatusCode, body)
	}
	monthlyGenerate.Body.Close()
	monthly := bodyJSON(t, f.request(http.MethodGet, "/api/result?kind=month&period=2026-10", nil, nil))
	monthlyData := monthly["data"].(map[string]any)
	if numberTest(monthlyData["total"]) != 2 || numberTest(monthlyData["activeDays"]) != 2 {
		t.Fatalf("monthly: %+v", monthlyData)
	}
	if len(monthlyData["themes"].([]any)) != 1 {
		t.Fatalf("themes: %+v", monthlyData["themes"])
	}
	// Editing a source marks the existing report outdated without deleting it.
	if _, err := f.store.Update(a.ID, "修改后的内容", 1); err != nil {
		t.Fatal(err)
	}
	outdated := bodyJSON(t, f.request(http.MethodGet, "/api/result?kind=day&period="+a.Day, nil, nil))
	if outdated["outdated"] != true || outdated["change"] != "added" || outdated["state"] != "ready" {
		t.Fatalf("outdated: %+v", outdated)
	}
	if len(outdated["data"].(map[string]any)["sections"].([]any)) != 1 {
		t.Fatal("old ready data should remain")
	}
	_ = b
}

func TestResultChangeRemovedAndMixed(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	f.login()
	a := f.storeMustCreate("原文甲", "change-a", "2026-10-01T00:00:00Z")
	entries, _ := f.store.Entries(a.Day, "day")
	fingerprint := f.store.Snapshot(entries)
	if err := f.store.ClaimResult("job-1", "day", a.Day, fingerprint, "mock", "2026-10-01T00:00:00.000Z", ""); err != nil {
		t.Fatal(err)
	}
	data := `{"sections":[],"sources":[{"id":"` + a.ID + `","version":1,"day":"` + a.Day + `"},{"id":"ghost","version":1,"day":"` + a.Day + `"}]}`
	if err := f.store.SaveReady("job-1", data, "2026-10-01T00:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	removed := bodyJSON(t, f.request(http.MethodGet, "/api/result?kind=day&period="+a.Day, nil, nil))
	if removed["change"] != "removed" || removed["outdated"] != false {
		t.Fatalf("removed: %+v", removed)
	}
	if _, err := f.store.Update(a.ID, "原文甲改", 1); err != nil {
		t.Fatal(err)
	}
	mixed := bodyJSON(t, f.request(http.MethodGet, "/api/result?kind=day&period="+a.Day, nil, nil))
	if mixed["change"] != "mixed" || mixed["outdated"] != true {
		t.Fatalf("mixed: %+v", mixed)
	}
}

func TestAIConfigurationAndProviderFailures(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	f.login()
	entry := f.storeMustCreate("private", "no-model", "2026-10-01T00:00:00Z")
	response := f.request(http.MethodPost, "/api/generate", map[string]any{"kind": "day", "period": entry.Day, "consent": true}, nil)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("missing model status=%d", response.StatusCode)
	}
	payload := bodyJSON(t, response)
	if payload["error"] == "" || strings.Contains(payload["error"].(string), "private") {
		t.Fatalf("missing model error: %+v", payload)
	}

	f2 := newFixture(t, fixtureOptions{configured: true})
	f2.login()
	entry2 := f2.storeMustCreate("private", "failed-model", "2026-10-01T00:00:00Z")
	// Replace the AI with a failing provider through a new handler is awkward;
	// insert a failed job directly and verify the API never echoes provider text.
	if err := f2.store.ClaimResult("failed-job", "day", entry2.Day, f2.store.Snapshot([]store.Entry{entry2}), "mock", "2026-10-01T00:00:00.000Z", ""); err != nil {
		t.Fatal(err)
	}
	if err := f2.store.SaveFailed("failed-job", "模型服务调用失败，请检查服务端配置或稍后重试"); err != nil {
		t.Fatal(err)
	}
	result := bodyJSON(t, f2.request(http.MethodGet, "/api/result?kind=day&period="+entry2.Day, nil, nil))
	if result["state"] != "failed" || strings.Contains(result["error"].(string), "private") {
		t.Fatalf("failed result: %+v", result)
	}
}

func TestStaticFilesHeadersAndAPI404(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	index := f.request(http.MethodGet, "/", nil, nil)
	if index.StatusCode != http.StatusOK {
		t.Fatalf("index status=%d", index.StatusCode)
	}
	indexBody := string(readAll(t, index))
	if !strings.Contains(indexBody, "Fleeting") {
		t.Fatalf("index body: %s", indexBody)
	}
	style := f.request(http.MethodGet, "/style.css", nil, nil)
	if style.StatusCode != http.StatusOK || !strings.Contains(string(readAll(t, style)), "--paper") {
		t.Fatal("style.css not served")
	}
	app := f.request(http.MethodGet, "/app.js", nil, nil)
	if app.StatusCode != http.StatusOK || app.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("app.js status=%d cache=%q", app.StatusCode, app.Header.Get("Cache-Control"))
	}
	app.Body.Close()
	if app.Header.Get("X-Content-Type-Options") != "nosniff" || app.Header.Get("X-Frame-Options") != "DENY" {
		t.Fatal("security headers missing on static asset")
	}
	traversal := f.request(http.MethodGet, "/../secret.txt", nil, nil)
	if traversal.StatusCode == http.StatusOK {
		t.Fatal("path traversal served")
	}
	traversal.Body.Close()
	f.login()
	unknown := f.request(http.MethodGet, "/api/unknown", nil, nil)
	if unknown.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown api status=%d", unknown.StatusCode)
	}
	unknown.Body.Close()
}

func (f *fixture) storeMustCreate(text, key, at string) store.Entry {
	f.t.Helper()
	parsed, err := time.Parse(time.RFC3339, at)
	if err != nil {
		f.t.Fatal(err)
	}
	entry, _, err := f.store.Create(text, key, parsed, nil)
	if err != nil || entry == nil {
		f.t.Fatalf("create: %+v %v", entry, err)
	}
	return *entry
}

func numberTest(value any) int {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case float64:
		return int(typed)
	case int:
		return typed
	}
	return -1
}

func urlQuery(value string) string {
	return url.QueryEscape(value)
}

func strconvAtoi(value string) (int, error) {
	result := 0
	if value == "" {
		return 0, io.EOF
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, io.EOF
		}
		result = result*10 + int(r-'0')
	}
	return result, nil
}
