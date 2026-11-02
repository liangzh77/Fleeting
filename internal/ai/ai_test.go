package ai

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/jsonutil"
	"github.com/liangzh77/fleeting/internal/store"
	"github.com/liangzh77/fleeting/internal/textutil"
)

type mockCall struct {
	Prompt string
	Data   any
	Body   map[string]any
}

type mockReply struct {
	Data    any
	Content string
	Finish  string
}

type mockFunc func(mockCall) mockReply

func reply(data any) mockReply          { return mockReply{Data: data} }
func truncatedReply() mockReply         { return mockReply{Finish: "length"} }
func rawReply(content string) mockReply { return mockReply{Content: content} }

func testConfig() config.Config {
	return config.Config{
		Origin: "http://localhost:3000", Timezone: "UTC", Database: ":memory:",
		PasswordHash: "test-only",
		LLM: config.LLM{
			BaseURL: "https://example.invalid", APIKey: "mock-test-placeholder", Model: "mock",
		},
	}
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:", "UTC", true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func newTestAI(t *testing.T, st *store.Store, cfg config.Config, fn mockFunc) *AI {
	t.Helper()
	return NewWithFetcher(st, cfg, func(request *http.Request) (*http.Response, error) {
		rawBody, _ := io.ReadAll(request.Body)
		var body map[string]any
		if err := jsonutil.Decode(rawBody, &body); err != nil {
			t.Fatalf("request body: %v", err)
		}
		messages, _ := body["messages"].([]any)
		if len(messages) != 2 {
			t.Fatalf("messages: %+v", body["messages"])
		}
		prompt, _ := messages[0].(map[string]any)["content"].(string)
		userContent, _ := messages[1].(map[string]any)["content"].(string)
		var data any
		if err := jsonutil.Decode([]byte(userContent), &data); err != nil {
			t.Fatalf("user data: %v", err)
		}
		result := fn(mockCall{Prompt: prompt, Data: data, Body: body})
		content := result.Content
		if content == "" {
			encoded, err := jsonutil.Marshal(result.Data)
			if err != nil {
				t.Fatal(err)
			}
			content = string(encoded)
		}
		finish := result.Finish
		if finish == "" {
			finish = "stop"
		}
		envelope, _ := jsonutil.Marshal(map[string]any{
			"choices": []any{map[string]any{
				"finish_reason": finish,
				"message":       map[string]any{"content": content},
			}},
		})
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(bytes.NewReader(envelope)),
		}, nil
	}, func(string, ...any) {})
}

func mustCreate(t *testing.T, st *store.Store, text, key string, at time.Time) store.Entry {
	t.Helper()
	entry, _, err := st.Create(text, key, at, nil)
	if err != nil || entry == nil {
		t.Fatalf("create: %+v %v", entry, err)
	}
	return *entry
}

func readyData(t *testing.T, st *store.Store, kind, period string) map[string]any {
	t.Helper()
	result, err := st.LatestReady(kind, period)
	if err != nil || result == nil || result.Data == nil {
		t.Fatalf("ready result: %+v %v", result, err)
	}
	var data map[string]any
	if err := jsonutil.Decode([]byte(*result.Data), &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func inputList(data any) []any {
	if object, ok := data.(map[string]any); ok {
		if originals, ok := object["originals"].([]any); ok {
			return originals
		}
	}
	if list, ok := data.([]any); ok {
		return list
	}
	return nil
}

// standardMock mirrors the Node test double: classification, month reviews and
// faithful daily sections. Extra callbacks let individual tests override.
type standardMock struct {
	classify func([]any) any
	review   func(mockCall, []any) any
	daily    func(mockCall, []any) any
	onCall   func(mockCall)
	truncate func(mockCall) bool
}

func (m *standardMock) fetch(call mockCall) mockReply {
	if m.onCall != nil {
		m.onCall(call)
	}
	if m.truncate != nil && m.truncate(call) {
		return truncatedReply()
	}
	taskData := call.Data
	if object, ok := call.Data.(map[string]any); ok {
		if task, hasTask := object["task"]; hasTask {
			taskData = task
		}
	}
	if strings.Contains(call.Prompt, "按每条原文抽取") {
		entries := taskData.([]any)
		if m.classify != nil {
			return reply(m.classify(entries))
		}
		out := make([]any, 0, len(entries))
		for _, entry := range entries {
			item := entry.(map[string]any)
			text, _ := item["text"].(string)
			themes := []any{"生活与日常", "家庭与亲子"}
			if strings.Contains(text, "AI") {
				themes = []any{"生活与日常", "AI与技术"}
			}
			out = append(out, map[string]any{
				"id": item["id"], "themes": themes, "points": text,
			})
		}
		return reply(map[string]any{"entries": out})
	}
	if strings.Contains(call.Prompt, "生成月度回顾") {
		originals := inputList(taskData)
		if m.review != nil {
			return reply(m.review(call, originals))
		}
		evidence := make([]any, 0, len(originals))
		for _, original := range originals {
			item := original.(map[string]any)
			text, _ := item["text"].(string)
			evidence = append(evidence, map[string]any{"id": item["id"], "quote": text})
		}
		insight := map[string]any{
			"fact": "记录中的自述", "advice": "基于事实的专业建议",
			"limitation": "材料较少，非诊断", "question": "还有哪些不同情境？",
			"evidence": evidence,
		}
		return reply(map[string]any{
			"total": 99999, "themes": []any{map[string]any{"name": "模型猜计数", "count": 99999}},
			"overview": "材料较少，仅初步归纳",
			"insights": []any{insight, insight},
			"changes":  []any{insight}, "connections": []any{insight},
			"questions": []any{map[string]any{"text": "尚未在记录中见到回答", "evidence": evidence}},
		})
	}
	entries := inputList(taskData)
	if m.daily != nil {
		return reply(m.daily(call, entries))
	}
	sections := make([]any, 0, len(entries))
	for _, entry := range entries {
		item := entry.(map[string]any)
		text, _ := item["text"].(string)
		sections = append(sections, map[string]any{
			"period":   "时间段",
			"segments": []any{map[string]any{"text": text, "sources": []any{item["id"]}}},
		})
	}
	return reply(map[string]any{"sections": sections})
}

func TestDailyAndMonthlyHappyPath(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	mock := &standardMock{}
	service := newTestAI(t, st, cfg, mock.fetch)
	a := mustCreate(t, st, "昨晚和孩子聊了 3 次，控制还是放手？", "mock-evidence-a", mustTime("2026-10-01T00:00:00Z"))
	b := mustCreate(t, st, "AI 产品想减少控制，但也担心错误。", "mock-evidence-b", mustTime("2026-10-02T10:00:00Z"))

	if err := service.Generate("day", a.Day, ""); err != nil {
		t.Fatal(err)
	}
	daily := readyData(t, st, "day", a.Day)
	sections := daily["sections"].([]any)
	segment := sections[0].(map[string]any)["segments"].([]any)[0].(map[string]any)
	if segment["text"] != a.Text {
		t.Fatalf("daily text: %+v", segment)
	}
	source := daily["sources"].([]any)[0].(map[string]any)
	if source["version"].(json.Number).String() != "1" {
		t.Fatalf("daily source: %+v", source)
	}
	if daily["promptVersion"] != "3" {
		t.Fatalf("promptVersion: %+v", daily["promptVersion"])
	}

	if err := service.Generate("month", "2026-10", ""); err != nil {
		t.Fatal(err)
	}
	monthly := readyData(t, st, "month", "2026-10")
	if number(monthly["total"]) != 2 || number(monthly["activeDays"]) != 2 {
		t.Fatalf("counts: %+v", monthly)
	}
	themes := monthly["themes"].([]any)
	foundLife := false
	for _, item := range themes {
		theme := item.(map[string]any)
		if theme["name"] == "生活与日常" {
			foundLife = true
			if number(theme["count"]) != 2 {
				t.Fatalf("theme count: %+v", theme)
			}
		}
	}
	if !foundLife {
		t.Fatalf("themes: %+v", themes)
	}
	insights := monthly["insights"].([]any)
	if len(insights) != 2 {
		t.Fatalf("insights: %+v", insights)
	}
	firstInsight := insights[0].(map[string]any)
	if firstInsight["advice"] != "基于事实的专业建议" {
		t.Fatalf("advice field: %+v", firstInsight)
	}
	if _, hasLegacyHypothesis := firstInsight["hypothesis"]; hasLegacyHypothesis {
		t.Fatalf("new result should use advice, not hypothesis: %+v", firstInsight)
	}
	evidence := insights[0].(map[string]any)["evidence"].([]any)[0].(map[string]any)
	if evidence["day"] != "2026-10-01" {
		t.Fatalf("evidence day: %+v", evidence)
	}
	if len(monthly["sources"].([]any)) != 2 {
		t.Fatalf("sources: %+v", monthly["sources"])
	}
	if monthly["promptVersion"] != "5" {
		t.Fatalf("monthly promptVersion: %+v", monthly["promptVersion"])
	}
	_ = b
}

func TestGroundingNormalizationAndChunkedMonthly(t *testing.T) {
	scenarios := []struct {
		name  string
		text  string
		quote string
		exact string
	}{
		{"空白映射（换行、制表、全角空格与代理对）", "前缀😀甲\n  乙\t丙　丁后缀", "😀甲 \n 乙 丙 丁", "😀甲\n  乙\t丙　丁"},
		{"标点映射", "前缀“甲”，乙！（丙）。后缀", `"甲",乙!(丙).`, "“甲”，乙！（丙）。"},
		{"不归一化全角字母/数字", "Ａ１２", "A12", ""},
		{"连续跨2000字分片且重复id", strings.Repeat("甲", 1998) + "边界前后引用" + strings.Repeat("乙", 2100), "边界前后引用", "边界前后引用"},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			st := newStore(t)
			cfg := testConfig()
			entry := mustCreate(t, st, scenario.text, "synthetic", time.Now())
			leaves, merges := 0, 0
			var warnings []string
			service := NewWithFetcher(st, cfg, func(request *http.Request) (*http.Response, error) {
				rawBody, _ := io.ReadAll(request.Body)
				var body map[string]any
				jsonutil.Decode(rawBody, &body)
				messages := body["messages"].([]any)
				prompt := messages[0].(map[string]any)["content"].(string)
				var data any
				jsonutil.Decode([]byte(messages[1].(map[string]any)["content"].(string)), &data)
				if strings.Contains(prompt, "按每条原文抽取") {
					out := []any{}
					for _, item := range data.([]any) {
						entry := item.(map[string]any)
						out = append(out, map[string]any{"id": entry["id"], "themes": []any{"生活与日常"}, "points": "要点"})
					}
					return mockHTTP(t, reply(map[string]any{"entries": out}))
				}
				if object, ok := data.(map[string]any); ok {
					if _, hasError := object["error"]; hasError {
						t.Fatal("unexpected repair call")
					}
					if _, hasReviews := object["reviews"]; hasReviews {
						merges++
						for _, original := range object["originals"].([]any) {
							text := original.(map[string]any)["text"].(string)
							if !strings.Contains(scenario.text, text) {
								t.Fatal("aggregation received text outside the original")
							}
						}
					} else {
						leaves++
					}
				} else {
					leaves++
				}
				evidence := []any{map[string]any{"id": entry.ID, "quote": scenario.quote}}
				return mockHTTP(t, reply(map[string]any{
					"overview": "概括",
					"insights": []any{map[string]any{"fact": "事实", "evidence": evidence}},
					"changes":  []any{}, "connections": []any{},
					"questions": []any{map[string]any{"text": "问题", "evidence": evidence}},
				}))
			}, func(format string, args ...any) {
				warnings = append(warnings, format)
			})
			month := entry.Day[:7]
			if err := service.Generate("month", month, ""); err != nil {
				t.Fatal(err)
			}
			out := readyData(t, st, "month", month)
			insights := out["insights"].([]any)
			if scenario.exact != "" {
				quote := insights[0].(map[string]any)["evidence"].([]any)[0].(map[string]any)["quote"]
				if quote != scenario.exact {
					t.Fatalf("quote=%q want %q", quote, scenario.exact)
				}
				if !strings.Contains(scenario.text, quote.(string)) {
					t.Fatal("quote is not an original substring")
				}
				item := insights[0].(map[string]any)
				for _, key := range []string{"advice", "limitation", "question"} {
					if item[key] != "" {
						t.Fatalf("%s should be empty: %+v", key, item)
					}
				}
			} else {
				if len(insights) != 0 || len(out["questions"].([]any)) != 0 {
					t.Fatalf("fabricated evidence should be dropped: %+v", out)
				}
			}
			if textutil.Len(scenario.text) > 4000 && (leaves < 3 || merges < 2) {
				t.Fatalf("leaves=%d merges=%d", leaves, merges)
			}
			_ = warnings
		})
	}
}

func TestDailyTruncationRerunsBothStages(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	text := "开始" + strings.Repeat("中", 1996) + "结束"
	entry := mustCreate(t, st, text, "a", time.Now())
	truncatedOnce := false
	first, second := 0, 0
	mock := &standardMock{
		daily: func(call mockCall, entries []any) any {
			isCheck := false
			if object, ok := call.Data.(map[string]any); ok {
				_, isCheck = object["originals"]
			}
			if isCheck {
				second++
				if !truncatedOnce {
					truncatedOnce = true
					return nil
				}
			} else {
				first++
			}
			sections := []any{}
			for _, item := range entries {
				entry := item.(map[string]any)
				sections = append(sections, map[string]any{
					"segments": []any{map[string]any{"text": entry["text"], "sources": []any{entry["id"]}}},
				})
			}
			return map[string]any{"sections": sections}
		},
		truncate: func(call mockCall) bool {
			if object, ok := call.Data.(map[string]any); ok {
				if _, isCheck := object["originals"]; isCheck && !truncatedOnce {
					truncatedOnce = true
					second++
					return true
				}
			}
			return false
		},
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	if err := service.Generate("day", entry.Day, ""); err != nil {
		t.Fatal(err)
	}
	out := readyData(t, st, "day", entry.Day)
	var joined strings.Builder
	for _, section := range out["sections"].([]any) {
		for _, segment := range section.(map[string]any)["segments"].([]any) {
			joined.WriteString(segment.(map[string]any)["text"].(string))
		}
	}
	if joined.String() != text {
		t.Fatalf("joined text differs: %q", joined.String())
	}
	if first != 3 || second != 3 {
		t.Fatalf("first=%d second=%d", first, second)
	}
}

func TestMonthlyTruncationCompressionAndBudget(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	a := mustCreate(t, st, strings.Repeat("甲", 2000), "a", time.Now())
	mustCreate(t, st, strings.Repeat("乙", 2000), "b", time.Now())
	mustCreate(t, st, strings.Repeat("丙", 2000), "c", time.Now())
	aggregated := false
	compressions := 0
	calls := 0
	fail := false
	mock := &standardMock{
		onCall: func(mockCall) { calls++ },
		review: func(call mockCall, originals []any) any {
			if strings.Contains(call.Prompt, "压缩这个回顾") {
				compressions++
			}
			evidence := []any{}
			for index, item := range originals {
				if index >= 2 {
					break
				}
				entry := item.(map[string]any)
				text := entry["text"].(string)
				quote := text
				if len([]rune(text)) > 10 {
					quote = string([]rune(text)[:10])
				}
				evidence = append(evidence, map[string]any{"id": entry["id"], "quote": quote})
			}
			insight := map[string]any{
				"fact": "材料", "advice": "建议", "limitation": "有局限",
				"question": "问题", "evidence": evidence,
			}
			return map[string]any{
				"overview": "层级归纳", "insights": []any{insight, insight},
				"changes": []any{}, "connections": []any{}, "questions": []any{},
			}
		},
		truncate: func(call mockCall) bool {
			object, ok := call.Data.(map[string]any)
			if !ok {
				return false
			}
			if _, hasError := object["error"]; hasError {
				return false
			}
			if _, hasReviews := object["reviews"]; hasReviews && (fail || !aggregated) {
				aggregated = true
				return true
			}
			return false
		},
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	month := a.Day[:7]
	if err := service.Generate("month", month, ""); err != nil {
		t.Fatal(err)
	}
	if compressions != 2 {
		t.Fatalf("compressions=%d", compressions)
	}
	out := readyData(t, st, "month", month)
	if number(out["total"]) != 3 {
		t.Fatalf("total: %+v", out["total"])
	}
	if len(out["classifications"].([]any)) != 3 {
		t.Fatalf("classifications: %+v", out["classifications"])
	}
	old, _ := st.LatestReady("month", month)
	if old == nil || old.Data == nil {
		t.Fatal("missing ready result")
	}
	fail = true
	calls = 0
	if err := service.Generate("month", month, ""); err == nil || !strings.Contains(err.Error(), "自动拆分/重试") {
		t.Fatalf("expected bounded truncation failure, got %v", err)
	}
	if calls >= 10 {
		t.Fatalf("calls=%d", calls)
	}
	current, _ := st.LatestReady("month", month)
	if current == nil || current.ID != old.ID || current.Data == nil || *current.Data != *old.Data {
		t.Fatal("old ready result was not retained")
	}
}

func TestStructureRepairOnceAndSoftCaps(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	entries := []store.Entry{
		mustCreate(t, st, "合成材料甲", "0", time.Now()),
		mustCreate(t, st, "合成材料乙", "1", time.Now()),
	}
	repairs := 0
	calls := 0
	firstClassification := true
	mock := &standardMock{
		onCall: func(call mockCall) {
			calls++
			if object, ok := call.Data.(map[string]any); ok {
				if _, hasError := object["error"]; hasError {
					repairs++
				}
			}
		},
		classify: func(entries []any) any {
			if firstClassification {
				firstClassification = false
				return map[string]any{}
			}
			out := []any{}
			for _, item := range entries {
				entry := item.(map[string]any)
				themes := []any{"工作与事业", "AI与技术", "学习与思考", "家庭与亲子", "人际与沟通", "情绪与心理", "健康与身体"}
				out = append(out, map[string]any{
					"id": entry["id"], "themes": themes,
					"points": strings.Repeat("字", 999) + "😀",
				})
			}
			if len(out) > 0 {
				out = append(out, out[0])
			}
			return map[string]any{"entries": out}
		},
		review: func(call mockCall, originals []any) any {
			item := originals[0].(map[string]any)
			text := item["text"].(string)
			quote := text
			if len([]rune(text)) > 10 {
				quote = string([]rune(text)[:10])
			}
			evidence := []any{map[string]any{"id": item["id"], "quote": quote}}
			insight := map[string]any{
				"fact": strings.Repeat("字", 199) + "😀", "evidence": evidence,
			}
			insights := []any{}
			for index := 0; index < 5; index++ {
				insights = append(insights, insight)
			}
			changes := []any{}
			for index := 0; index < 7; index++ {
				changes = append(changes, insight)
			}
			questions := []any{}
			for index := 0; index < 5; index++ {
				questions = append(questions, map[string]any{"text": "问题" + itoa(index), "evidence": evidence})
			}
			return map[string]any{
				"overview": strings.Repeat("字", 999) + "😀",
				"insights": insights, "changes": changes, "connections": changes,
				"questions": questions,
			}
		},
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	month := entries[0].Day[:7]
	if err := service.Generate("month", month, ""); err != nil {
		t.Fatal(err)
	}
	if repairs != 1 {
		t.Fatalf("repairs=%d", repairs)
	}
	out := readyData(t, st, "month", month)
	if len(out["insights"].([]any)) != 4 || len(out["changes"].([]any)) != 6 ||
		len(out["connections"].([]any)) != 6 || len(out["questions"].([]any)) != 4 {
		t.Fatalf("soft caps: %+v", out)
	}
	if textutil.Len(out["overview"].(string)) != 999 {
		t.Fatalf("overview length=%d", textutil.Len(out["overview"].(string)))
	}
	firstInsight := out["insights"].([]any)[0].(map[string]any)
	if textutil.Len(firstInsight["fact"].(string)) != 199 {
		t.Fatalf("fact length=%d", textutil.Len(firstInsight["fact"].(string)))
	}
	themes := out["themes"].([]any)
	if len(themes) != 2 {
		t.Fatalf("themes=%d", len(themes))
	}
	for _, item := range themes {
		if number(item.(map[string]any)["count"]) != 2 {
			t.Fatalf("theme count: %+v", item)
		}
	}
	if calls != 3 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestFabricatedEvidenceDroppedAndOldReadyRetained(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	a := mustCreate(t, st, "合成原文甲", "a", time.Now())
	mustCreate(t, st, "合成原文乙", "b", time.Now())
	fail := false
	repairs := 0
	bogus := map[string]any{"id": a.ID, "quote": "不存在的模型改写"}
	mock := &standardMock{
		review: func(call mockCall, originals []any) any {
			object := call.Data.(map[string]any)
			if _, hasError := object["error"]; hasError {
				repairs++
			}
			valid := map[string]any{"id": a.ID, "quote": a.Text}
			evidence := []any{valid}
			if fail {
				evidence = []any{bogus}
			} else {
				evidence = []any{bogus, valid}
			}
			return map[string]any{
				"overview": "概括",
				"insights": []any{
					map[string]any{"fact": "有效事实", "hypothesis": "", "limitation": "  ", "question": "", "evidence": evidence},
					map[string]any{"fact": "不可信", "evidence": []any{bogus}},
					map[string]any{"fact": "无证据"},
				},
				"changes":     []any{map[string]any{"fact": "变化", "evidence": []any{}}},
				"connections": []any{},
				"questions": []any{
					map[string]any{"text": "问题", "evidence": []any{bogus}},
					map[string]any{"text": "缺证据"},
				},
			}
		},
		truncate: func(call mockCall) bool { return false },
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	month := a.Day[:7]
	if err := service.Generate("month", month, ""); err != nil {
		t.Fatal(err)
	}
	out := readyData(t, st, "month", month)
	if len(out["insights"].([]any)) != 1 || len(out["questions"].([]any)) != 0 || len(out["changes"].([]any)) != 0 {
		t.Fatalf("dropped evidence: %+v", out)
	}
	ready, _ := st.LatestReady("month", month)
	if ready == nil || ready.Data == nil || strings.Contains(*ready.Data, "不存在的模型改写") {
		t.Fatal("bogus quote stored")
	}
	fail = true
	err := service.Generate("month", month, "")
	if err == nil || !strings.Contains(err.Error(), "洞察不足") {
		t.Fatalf("expected minimum failure, got %v", err)
	}
	if repairs != 1 {
		t.Fatalf("repairs=%d", repairs)
	}
	current, _ := st.LatestReady("month", month)
	if current == nil || current.ID != ready.ID {
		t.Fatal("old ready replaced after failure")
	}
	job, _ := st.LatestJob("month", month)
	if job == nil || job.Error == nil || strings.Contains(*job.Error, a.Text) || strings.Contains(*job.Error, cfg.LLM.APIKey) {
		t.Fatalf("job error leaks data: %+v", job)
	}
}

func TestAggregationCannotExpandEvidence(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	longText := strings.Repeat("甲", 1999) + strings.Repeat("乙", 2001)
	e := mustCreate(t, st, longText, "a", time.Now())
	other := mustCreate(t, st, "另一个记录", "b", time.Now())
	repairs := 0
	mock := &standardMock{
		review: func(call mockCall, originals []any) any {
			object := call.Data.(map[string]any)
			taskObject := object
			if task, ok := object["task"].(map[string]any); ok {
				taskObject = task
			}
			if _, hasError := object["error"]; hasError {
				repairs++
			}
			quote := "甲乙"
			if _, hasReviews := taskObject["reviews"]; !hasReviews {
				quote = "甲"
			}
			evidence := []any{map[string]any{"id": e.ID, "quote": quote}}
			return map[string]any{
				"overview": "概括",
				"insights": []any{map[string]any{"fact": "事实", "evidence": evidence}},
				"changes":  []any{}, "connections": []any{}, "questions": []any{},
			}
		},
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	month := e.Day[:7]
	err := service.Generate("month", month, "")
	if err == nil || !strings.Contains(err.Error(), "月度层级聚合结构校验失败") || !strings.Contains(err.Error(), "洞察不足") {
		t.Fatalf("expected aggregate grounding failure, got %v", err)
	}
	if repairs != 1 {
		t.Fatalf("repairs=%d", repairs)
	}
	_ = other
}

func TestDailyFabricatedSourcesRejected(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	a := mustCreate(t, st, strings.Repeat("x", 7000), "large-source-a", time.Now())
	mustCreate(t, st, strings.Repeat("y", 7000), "large-source-b", time.Now())
	for _, mock := range []mockFunc{
		func(mockCall) mockReply { return rawReply("not json") },
		func(mockCall) mockReply {
			return reply(map[string]any{"sections": []any{map[string]any{"period": "上午", "segments": []any{map[string]any{"text": "fake", "sources": []any{"nonexistent"}}}}}})
		},
		func(mockCall) mockReply {
			return reply(map[string]any{"sections": []any{map[string]any{"segments": []any{map[string]any{"text": "fake", "sources": []any{}}}}}})
		},
		func(mockCall) mockReply {
			return reply(map[string]any{"sections": []any{map[string]any{"segments": []any{map[string]any{"text": "fake", "sources": []any{a.ID}}}}}})
		},
		func(mockCall) mockReply { return reply(map[string]any{"sections": []any{}}) },
		func(mockCall) mockReply {
			return reply(map[string]any{"sections": []any{map[string]any{"segments": []any{}}}})
		},
	} {
		service := newTestAI(t, st, cfg, mock)
		if err := service.Generate("day", a.Day, ""); err == nil {
			t.Fatalf("invalid daily output accepted: %+v", mock)
		}
	}
}

func TestAutomaticAttemptIsDurable(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	entry := mustCreate(t, st, "自动整理材料", "a", time.Now())
	service := newTestAI(t, st, cfg, (&standardMock{}).fetch)
	// automaticDay is deliberately a different label than the entry day.
	if err := service.Generate("day", entry.Day, "2026-10-08"); err != nil {
		t.Fatal(err)
	}
	if err := service.Generate("day", entry.Day, "2026-10-08"); err == nil || !strings.Contains(err.Error(), "本日自动整理已尝试") {
		t.Fatalf("second automatic attempt: %v", err)
	}
}

func TestOversizedManualRejectedBeforeCallingModel(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	calls := 0
	service := newTestAI(t, st, cfg, func(mockCall) mockReply {
		calls++
		return reply(map[string]any{})
	})
	for index := 0; index < 16; index++ {
		mustCreate(t, st, strings.Repeat("x", 8000), "oversize-"+itoa(index), time.Now())
	}
	entries, _ := st.Entries(time.Now().UTC().Format("2006-01-02"), "day")
	err := service.Generate("day", entries[0].Day, "")
	if err == nil || !strings.Contains(err.Error(), "12 万") {
		t.Fatalf("oversized: %v", err)
	}
	if calls != 0 {
		t.Fatalf("model called %d times", calls)
	}
}

func TestSharedBudgetStopsAt512(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	for index := 0; index < 15; index++ {
		mustCreate(t, st, strings.Repeat(itoa(index%10), 8000), "budget-"+itoa(index), time.Now())
	}
	repairs := 0
	calls := 0
	service := newTestAI(t, st, cfg, func(call mockCall) mockReply {
		calls++
		if object, ok := call.Data.(map[string]any); ok {
			if _, hasError := object["error"]; hasError {
				repairs++
				task := object["task"].([]any)
				if len(task) > 1 || textutil.Len(task[0].(map[string]any)["text"].(string)) > 128 {
					return truncatedReply()
				}
				out := []any{}
				for _, item := range task {
					entry := item.(map[string]any)
					out = append(out, map[string]any{"id": entry["id"], "themes": []any{"其他"}, "points": "要点"})
				}
				return reply(map[string]any{"entries": out})
			}
		}
		if list, ok := call.Data.([]any); ok {
			if len(list) > 1 || textutil.Len(list[0].(map[string]any)["text"].(string)) > 128 {
				return truncatedReply()
			}
			return reply(map[string]any{})
		}
		return reply(map[string]any{})
	})
	entries, _ := st.Entries(time.Now().UTC().Format("2006-01"), "month")
	err := service.Generate("month", entries[0].Day[:7], "")
	if err == nil || !strings.Contains(err.Error(), "自动拆分/重试") {
		t.Fatalf("expected budget failure, got %v", err)
	}
	if calls != 512 {
		t.Fatalf("calls=%d", calls)
	}
	if repairs <= 100 {
		t.Fatalf("repairs=%d", repairs)
	}
	job, _ := st.LatestJob("month", entries[0].Day[:7])
	if job == nil || job.State != "failed" {
		t.Fatalf("job: %+v", job)
	}
}

func TestMonthlyThemeTaxonomyNeverExceedsTen(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	at := mustTime("2026-10-01T00:00:00Z")
	for index := 0; index < 20; index++ {
		mustCreate(t, st, "合成记录"+itoa(index)+"：第"+itoa(index)+"条测试内容。", "taxonomy-"+itoa(index), at.Add(time.Duration(index)*time.Minute))
	}
	mock := &standardMock{
		classify: func(entries []any) any {
			out := []any{}
			for index, item := range entries {
				entry := item.(map[string]any)
				first := monthlyThemes[index%len(monthlyThemes)]
				second := monthlyThemes[(index+1)%len(monthlyThemes)]
				out = append(out, map[string]any{
					"id": entry["id"], "themes": []any{first, second},
					"gist": "合成简介" + itoa(index), "points": "要点",
				})
			}
			return map[string]any{"entries": out}
		},
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	if err := service.Generate("month", "2026-10", ""); err != nil {
		t.Fatal(err)
	}
	out := readyData(t, st, "month", "2026-10")
	allowed := map[string]bool{}
	for _, theme := range monthlyThemes {
		allowed[theme] = true
	}
	themes := out["themes"].([]any)
	if len(themes) != len(monthlyThemes) {
		t.Fatalf("expected %d themes, got %d: %+v", len(monthlyThemes), len(themes), themes)
	}
	for _, item := range themes {
		theme := item.(map[string]any)
		name, _ := theme["name"].(string)
		if !allowed[name] || number(theme["count"]) < 1 {
			t.Fatalf("invalid chart theme: %+v", theme)
		}
	}
	classifications := out["classifications"].([]any)
	if len(classifications) != 20 {
		t.Fatalf("classifications=%d", len(classifications))
	}
	for _, item := range classifications {
		entry := item.(map[string]any)
		labels, _ := entry["themes"].([]any)
		if len(labels) == 0 || len(labels) > 2 {
			t.Fatalf("per-entry theme count: %+v", labels)
		}
		if gist, _ := entry["gist"].(string); gist == "" {
			t.Fatalf("missing gist: %+v", entry)
		}
		for _, label := range labels {
			if !allowed[label.(string)] {
				t.Fatalf("unexpected theme name: %v", label)
			}
		}
	}
	if out["promptVersion"] != "5" {
		t.Fatalf("promptVersion: %+v", out["promptVersion"])
	}
}

func TestUnknownThemeRepairedThenFoldedIntoOther(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	mustCreate(t, st, "合成原文甲", "unknown-a", mustTime("2026-10-01T00:00:00Z"))
	mustCreate(t, st, "合成原文乙", "unknown-b", mustTime("2026-10-02T00:00:00Z"))
	calls := 0
	mock := &standardMock{
		onCall: func(mockCall) { calls++ },
		classify: func(entries []any) any {
			out := []any{}
			for _, item := range entries {
				entry := item.(map[string]any)
				out = append(out, map[string]any{
					"id": entry["id"], "themes": []any{"不存在的主题"}, "points": "要点",
				})
			}
			return map[string]any{"entries": out}
		},
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	if err := service.Generate("month", "2026-10", ""); err != nil {
		t.Fatal(err)
	}
	out := readyData(t, st, "month", "2026-10")
	themes := out["themes"].([]any)
	if len(themes) != 1 || themes[0].(map[string]any)["name"] != "其他" {
		t.Fatalf("fallback themes: %+v", themes)
	}
	classifications := out["classifications"].([]any)
	for _, item := range classifications {
		labels := item.(map[string]any)["themes"].([]any)
		if len(labels) != 1 || labels[0] != "其他" {
			t.Fatalf("fallback labels: %+v", labels)
		}
	}
	if calls != 3 {
		t.Fatalf("calls=%d (expected initial + repair + leaf review)", calls)
	}
}

func TestLongEntryThemesCappedAfterChunkMerge(t *testing.T) {
	st := newStore(t)
	cfg := testConfig()
	text := strings.Repeat("甲", 3000) + strings.Repeat("乙", 3000)
	mustCreate(t, st, text, "long-theme", mustTime("2026-10-01T00:00:00Z"))
	mock := &standardMock{
		classify: func(entries []any) any {
			out := []any{}
			for _, item := range entries {
				entry := item.(map[string]any)
				themes := []any{"工作与事业", "AI与技术"}
				gist := "甲片段简介"
				if !strings.Contains(entry["text"].(string), "甲") {
					themes = []any{"学习与思考", "家庭与亲子"}
					gist = "乙片段简介"
				}
				out = append(out, map[string]any{
					"id": entry["id"], "themes": themes, "gist": gist, "points": "要点",
				})
			}
			return map[string]any{"entries": out}
		},
		review: func(call mockCall, originals []any) any {
			evidence := []any{}
			for _, original := range originals {
				item := original.(map[string]any)
				text := item["text"].(string)
				quote := text
				if len([]rune(text)) > 10 {
					quote = string([]rune(text)[:10])
				}
				evidence = append(evidence, map[string]any{"id": item["id"], "quote": quote})
			}
			return map[string]any{
				"overview": "概括",
				"insights": []any{map[string]any{"fact": "事实", "evidence": evidence}},
				"changes":  []any{}, "connections": []any{}, "questions": []any{},
			}
		},
	}
	service := newTestAI(t, st, cfg, mock.fetch)
	if err := service.Generate("month", "2026-10", ""); err != nil {
		t.Fatal(err)
	}
	out := readyData(t, st, "month", "2026-10")
	classifications := out["classifications"].([]any)
	if len(classifications) != 1 {
		t.Fatalf("classifications=%d", len(classifications))
	}
	labels := classifications[0].(map[string]any)["themes"].([]any)
	if len(labels) != 2 || labels[0] != "工作与事业" || labels[1] != "AI与技术" {
		t.Fatalf("merged labels: %+v", labels)
	}
	if gist := classifications[0].(map[string]any)["gist"]; gist != "甲片段简介" {
		t.Fatalf("merged gist: %+v", gist)
	}
	themes := out["themes"].([]any)
	if len(themes) != 2 {
		t.Fatalf("chart themes: %+v", themes)
	}
}

func TestInsightAdviceFieldAndLegacyFallback(t *testing.T) {
	cases := []struct {
		object map[string]any
		want   string
	}{
		{map[string]any{"advice": "专业建议"}, "专业建议"},
		{map[string]any{"hypothesis": "旧解释"}, "旧解释"},
		{map[string]any{"advice": "", "hypothesis": "旧解释"}, "旧解释"},
		{map[string]any{}, ""},
	}
	for _, item := range cases {
		got, err := insightAdvice(item.object, "insights[0]")
		if err != nil || got != item.want {
			t.Fatalf("insightAdvice(%+v)=%q, %v; want %q", item.object, got, err, item.want)
		}
	}
	if _, err := insightAdvice(map[string]any{"advice": nil}, "insights[0]"); err == nil {
		t.Fatal("null advice should be a structure error")
	}
}

func TestQuestionsValueDeduplicatesIdenticalText(t *testing.T) {
	entries := []store.Entry{{ID: "a", Text: "原文甲", Day: "2026-10-01"}}
	g := &generator{ai: &AI{warnf: func(string, ...any) {}}}
	evidence := []any{map[string]any{"id": "a", "quote": "原文甲"}}
	value := []any{
		map[string]any{"text": "同一个问题", "evidence": evidence},
		map[string]any{"text": "同一个问题", "evidence": evidence},
		map[string]any{"text": "另一个问题", "evidence": evidence},
	}
	questions, err := questionsValue(value, entries, 4, "questions", "test", g, nil)
	if err != nil || len(questions) != 2 {
		t.Fatalf("questions=%+v err=%v", questions, err)
	}
	if questions[0].Text != "同一个问题" || questions[1].Text != "另一个问题" {
		t.Fatalf("question order/content: %+v", questions)
	}
}

func mockHTTP(t *testing.T, result mockReply) (*http.Response, error) {
	t.Helper()
	content := result.Content
	if content == "" {
		encoded, err := jsonutil.Marshal(result.Data)
		if err != nil {
			t.Fatal(err)
		}
		content = string(encoded)
	}
	envelope, _ := jsonutil.Marshal(map[string]any{
		"choices": []any{map[string]any{
			"finish_reason": "stop",
			"message":       map[string]any{"content": content},
		}},
	})
	return &http.Response{
		StatusCode: 200, Header: http.Header{},
		Body: io.NopCloser(bytes.NewReader(envelope)),
	}, nil
}

func mustTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func number(value any) int {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case int:
		return typed
	case float64:
		return int(typed)
	}
	return -1
}
