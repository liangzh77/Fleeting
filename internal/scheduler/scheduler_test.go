package scheduler

import (
	"bytes"
	"io"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/liangzh77/fleeting/internal/ai"
	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/jsonutil"
	"github.com/liangzh77/fleeting/internal/store"
)

func schedulerConfig(timezone string) config.Config {
	return config.Config{
		Origin: "http://localhost:3000", Timezone: timezone, Database: ":memory:",
		PasswordHash: "test-only",
		LLM: config.LLM{
			BaseURL: "https://example.invalid", APIKey: "test-only", Model: "mock",
		},
	}
}

func dailyFetcher(calls *int) ai.Fetcher {
	return func(request *http.Request) (*http.Response, error) {
		(*calls)++
		rawBody, _ := io.ReadAll(request.Body)
		var body map[string]any
		_ = jsonutil.Decode(rawBody, &body)
		messages := body["messages"].([]any)
		var data any
		_ = jsonutil.Decode([]byte(messages[1].(map[string]any)["content"].(string)), &data)
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
		content, _ := jsonutil.Marshal(map[string]any{"sections": sections})
		envelope, _ := jsonutil.Marshal(map[string]any{
			"choices": []any{map[string]any{
				"finish_reason": "stop",
				"message":       map[string]any{"content": string(content)},
			}},
		})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(envelope)), Header: http.Header{}}, nil
	}
}

func failingFetcher(calls *int) ai.Fetcher {
	return func(*http.Request) (*http.Response, error) {
		(*calls)++
		return &http.Response{StatusCode: 500, Body: io.NopCloser(bytes.NewReader([]byte("private"))), Header: http.Header{}}, nil
	}
}

func TestTickScheduleRestartAndNoBackfill(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db.sqlite")
	st, err := store.Open(path, "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	day := "2026-10-06"
	if _, _, err := st.Create("昨天", "a", time.Now(), &day); err != nil {
		t.Fatal(err)
	}
	cfg := schedulerConfig("Asia/Shanghai")
	calls := 0
	service := ai.NewWithFetcher(st, cfg, dailyFetcher(&calls), nil)
	now := time.Date(2026, 10, 6, 16, 59, 0, 0, time.UTC)
	run := NewWithClock(st, service, func() time.Time { return now }, nil)
	if err := run.Tick(); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("00:59 calls=%d", calls)
	}
	now = time.Date(2026, 10, 6, 17, 0, 0, 0, time.UTC)
	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			_ = run.Tick()
		}()
	}
	wg.Wait()
	if calls != 2 {
		t.Fatalf("01:00 calls=%d", calls)
	}
	if ready, _ := st.LatestReady("day", day); ready == nil {
		t.Fatal("expected ready result")
	}
	now = time.Date(2026, 10, 6, 17, 1, 0, 0, time.UTC)
	_ = run.Tick()
	if calls != 2 {
		t.Fatalf("repeat tick calls=%d", calls)
	}
	st.Close()

	st, err = store.Open(path, "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	calls = 0
	service = ai.NewWithFetcher(st, cfg, dailyFetcher(&calls), nil)
	run = NewWithClock(st, service, func() time.Time { return now }, nil)
	_ = run.Tick()
	if calls != 0 {
		t.Fatalf("restart calls=%d", calls)
	}
	now = time.Date(2026, 10, 7, 17, 1, 0, 0, time.UTC)
	_ = run.Tick()
	if calls != 0 {
		t.Fatalf("new day backfilled calls=%d", calls)
	}
}

func TestAutomaticFailureIsDurable(t *testing.T) {
	st, err := store.Open(":memory:", "America/New_York", true)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	day := "2024-03-09"
	if _, _, err := st.Create("旧材料", "a", time.Now(), &day); err != nil {
		t.Fatal(err)
	}
	cfg := schedulerConfig("America/New_York")
	calls := 0
	service := ai.NewWithFetcher(st, cfg, failingFetcher(&calls), nil)
	now := time.Date(2024, 3, 10, 6, 0, 0, 0, time.UTC)
	run := NewWithClock(st, service, func() time.Time { return now }, nil)
	_ = run.Tick()
	if calls != 1 {
		t.Fatalf("calls=%d", calls)
	}
	attempted, _ := st.MetaHas("auto-day:2024-03-10")
	if !attempted {
		t.Fatal("automatic attempt marker missing")
	}
	_ = run.Tick()
	if calls != 1 {
		t.Fatalf("retry after failure: calls=%d", calls)
	}
}
