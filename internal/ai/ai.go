// Package ai ports the daily and monthly AI organization pipeline. All model
// output is untrusted: structure, source ids and evidence quotes are validated
// before anything is stored.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/liangzh77/fleeting/internal/auth"
	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/jsonutil"
	"github.com/liangzh77/fleeting/internal/store"
	"github.com/liangzh77/fleeting/internal/textutil"
)

// Evidence is one exact quote from an original entry.
type Evidence struct {
	ID    string `json:"id"`
	Quote string `json:"quote"`
	Day   string `json:"day"`
}

// Insight is one fact/advice item in a monthly review.
type Insight struct {
	Fact       string     `json:"fact"`
	Advice     string     `json:"advice"`
	Limitation string     `json:"limitation"`
	Question   string     `json:"question"`
	Evidence   []Evidence `json:"evidence"`
}

// DailySegment is one short paragraph of a daily organization.
type DailySegment struct {
	Text    string   `json:"text"`
	Sources []string `json:"sources"`
}

// DailySection groups segments under a program-computed time band.
type DailySection struct {
	Period   string         `json:"period"`
	Segments []DailySegment `json:"segments,omitempty"`
	Text     string         `json:"text,omitempty"`
	Sources  []string       `json:"sources"`
}

// Daily is the stored daily result body.
type Daily struct {
	Sections []DailySection `json:"sections"`
}

// Classification is one entry's multi-label classification and one-line gist.
type Classification struct {
	ID     string   `json:"id"`
	Themes []string `json:"themes"`
	Gist   string   `json:"gist,omitempty"`
}

// Theme is a program-counted theme (unique source ids).
type Theme struct {
	Name    string   `json:"name"`
	Count   int      `json:"count"`
	Sources []string `json:"sources"`
}

// Question is one open question with grounded evidence.
type Question struct {
	Text     string     `json:"text"`
	Evidence []Evidence `json:"evidence"`
}

// Monthly is the stored monthly result body.
type Monthly struct {
	Overview        string           `json:"overview"`
	Classifications []Classification `json:"classifications"`
	Themes          []Theme          `json:"themes"`
	Total           int              `json:"total"`
	ActiveDays      int              `json:"activeDays"`
	Insights        []Insight        `json:"insights"`
	Changes         []Insight        `json:"changes"`
	Connections     []Insight        `json:"connections"`
	Questions       []Question       `json:"questions"`
}

type sourceRef struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Day     string `json:"day"`
}

// input is what is sent to the model for one fragment.
type input struct {
	ID   string  `json:"id"`
	Day  string  `json:"day"`
	Time *string `json:"time"`
	Text string  `json:"text"`
}

type point struct {
	ID     string `json:"id"`
	Day    string `json:"day"`
	Points string `json:"points"`
}

type classified struct {
	point
	Themes []string `json:"themes"`
	Gist   string   `json:"gist,omitempty"`
}

// Fetcher is the injectable HTTP transport used by tests.
type Fetcher func(*http.Request) (*http.Response, error)

// AI is the generation service.
type AI struct {
	store   *store.Store
	cfg     config.Config
	fetcher Fetcher
	warnf   func(format string, args ...any)
}

// New creates an AI service backed by net/http.
func New(st *store.Store, cfg config.Config) *AI {
	return &AI{store: st, cfg: cfg, fetcher: http.DefaultClient.Do, warnf: log.Printf}
}

// NewWithFetcher creates an AI service with an explicit transport, for tests.
func NewWithFetcher(st *store.Store, cfg config.Config, fetcher Fetcher, warnf func(string, ...any)) *AI {
	if warnf == nil {
		warnf = func(string, ...any) {}
	}
	return &AI{store: st, cfg: cfg, fetcher: fetcher, warnf: warnf}
}

// Configured reports whether all three provider settings are present.
func (a *AI) Configured() bool {
	return a.cfg.LLM.BaseURL != "" && a.cfg.LLM.APIKey != "" && a.cfg.LLM.Model != ""
}

type aiError struct {
	message   string
	truncated bool
}

func (e *aiError) Error() string { return e.message }

type structureError struct {
	message string
	output  any
}

func (e *structureError) Error() string { return e.message }

func aiErr(message string) error { return &aiError{message: message} }

func truncatedErr() error { return &aiError{message: limitMessage, truncated: true} }

func isTruncated(err error) bool {
	var target *aiError
	return errors.As(err, &target) && target.truncated
}

func aiMessage(err error) string {
	var ae *aiError
	if errors.As(err, &ae) {
		return ae.message
	}
	var se *structureError
	if errors.As(err, &se) {
		return se.message
	}
	return "生成失败，请稍后重试"
}

// PublicMessage exposes a safe model error message for HTTP 503 responses.
func PublicMessage(err error) (string, bool) {
	var ae *aiError
	if errors.As(err, &ae) {
		return ae.message, true
	}
	var se *structureError
	if errors.As(err, &se) {
		return se.message, true
	}
	return "", false
}

type generator struct {
	ai      *AI
	entries []store.Entry
	inputs  []input
	chunks  [][]input
	calls   int
}

// Generate runs one daily or monthly organization job. automaticDay is set by
// the scheduler and durably marks that today's automatic attempt was consumed.
func (a *AI) Generate(kind, period, automaticDay string) error {
	if !a.Configured() {
		return aiErr("未配置模型；记录、回看和导出仍可使用")
	}
	running, err := a.store.HasRunning(kind, period)
	if err != nil {
		return aiErr("生成失败，请稍后重试")
	}
	if running {
		return aiErr("已有生成进行中，请稍后重试")
	}
	entries, err := a.store.Entries(period, kind)
	if err != nil {
		return aiErr("生成失败，请稍后重试")
	}
	if len(entries) == 0 {
		return aiErr("所选范围没有记录")
	}
	oversized := a.oversized(entries)
	if oversized && automaticDay == "" {
		return aiErr("首版单次最多 12 万字符 / 500 条，请缩小范围；原文未发送")
	}
	fingerprint := a.store.Snapshot(entries)
	id, err := auth.NewUUID()
	if err != nil {
		return aiErr("生成失败，请稍后重试")
	}
	if err := a.store.ClaimResult(id, kind, period, fingerprint, a.cfg.LLM.Model, config.FormatISO(time.Now()), automaticDay); err != nil {
		switch {
		case errors.Is(err, store.ErrAlreadyRunning):
			return aiErr("已有生成进行中，请稍后重试")
		case errors.Is(err, store.ErrAutoAttempted):
			return aiErr("本日自动整理已尝试")
		default:
			return aiErr("生成失败，请稍后重试")
		}
	}
	if err := a.run(id, kind, period, entries, oversized); err != nil {
		message := aiMessage(err)
		_ = a.store.SaveFailed(id, message)
		return aiErr(message)
	}
	return nil
}

func (a *AI) oversized(entries []store.Entry) bool {
	total := 0
	for _, entry := range entries {
		total += textutil.Len(entry.Text)
	}
	return total > 120000 || len(entries) > 500
}

func (a *AI) run(id, kind, period string, entries []store.Entry, oversized bool) error {
	if oversized {
		return aiErr("超过单次 12 万字符 / 500 条限制；原文未发送，旧整理保留")
	}
	inputs, err := buildInputs(entries, a.cfg.Location())
	if err != nil {
		return err
	}
	g := &generator{ai: a, entries: entries, inputs: inputs, chunks: buildChunks(inputs)}
	sources := make([]sourceRef, 0, len(entries))
	for _, entry := range entries {
		sources = append(sources, sourceRef{ID: entry.ID, Version: entry.Version, Day: entry.Day})
	}
	var data map[string]any
	if kind == "day" {
		sections, err := g.daily()
		if err != nil {
			return err
		}
		if sections == nil {
			sections = []DailySection{}
		}
		data = map[string]any{
			"sections":      sections,
			"sources":       sources,
			"promptVersion": "3",
		}
	} else {
		monthly, err := g.monthly()
		if err != nil {
			return err
		}
		data = map[string]any{
			"overview":        monthly.Overview,
			"classifications": monthly.Classifications,
			"themes":          monthly.Themes,
			"total":           monthly.Total,
			"activeDays":      monthly.ActiveDays,
			"insights":        monthly.Insights,
			"changes":         monthly.Changes,
			"connections":     monthly.Connections,
			"questions":       monthly.Questions,
			"sources":         sources,
			"promptVersion":   "5",
		}
	}
	encoded, err := jsonutil.Marshal(data)
	if err != nil {
		return err
	}
	return a.store.SaveReady(id, string(encoded), config.FormatISO(time.Now()))
}

func buildInputs(entries []store.Entry, location *time.Location) ([]input, error) {
	inputs := make([]input, 0, len(entries))
	for _, entry := range entries {
		var clock *string
		if entry.TimeUnknown == 0 {
			parsed, err := time.Parse(time.RFC3339Nano, entry.CreatedAt)
			if err != nil {
				return nil, aiErr("生成失败，请稍后重试")
			}
			formatted := parsed.In(location).Format("15:04")
			clock = &formatted
		}
		inputs = append(inputs, input{ID: entry.ID, Day: entry.Day, Time: clock, Text: entry.Text})
	}
	return inputs, nil
}

func buildChunks(inputs []input) [][]input {
	chunks := make([][]input, 0)
	chunk := make([]input, 0)
	size := 0
	for _, entry := range inputs {
		for start := 0; start < len(entry.Text); {
			end := start + textutil.PrefixByteIndex(entry.Text[start:], 2000)
			if end == start {
				end = len(entry.Text)
			}
			part := entry
			part.Text = entry.Text[start:end]
			start = end
			if size+textutil.Len(part.Text) > 4000 || chunkHasID(chunk, part.ID) {
				chunks = append(chunks, chunk)
				chunk = make([]input, 0)
				size = 0
			}
			chunk = append(chunk, part)
			size += textutil.Len(part.Text)
		}
	}
	if len(chunk) > 0 {
		chunks = append(chunks, chunk)
	}
	return chunks
}

func chunkHasID(chunk []input, id string) bool {
	for _, item := range chunk {
		if item.ID == id {
			return true
		}
	}
	return false
}

// splitBatch halves a batch, or halves a long single fragment. A fragment of
// 128 UTF-16 units or less cannot be split further.
func splitBatch(batch []input) ([][]input, error) {
	if len(batch) > 1 {
		middle := (len(batch) + 1) / 2
		return [][]input{batch[:middle], batch[middle:]}, nil
	}
	entry := batch[0]
	length := textutil.Len(entry.Text)
	if length <= 128 {
		return nil, aiErr(limitMessage)
	}
	middle := textutil.PrefixByteIndex(entry.Text, (length+1)/2)
	first := entry
	first.Text = entry.Text[:middle]
	second := entry
	second.Text = entry.Text[middle:]
	return [][]input{{first}, {second}}, nil
}

func insertChunks(chunks [][]input, index int, parts [][]input) [][]input {
	next := make([][]input, 0, len(chunks)+len(parts))
	next = append(next, chunks[:index+1]...)
	next = append(next, parts...)
	next = append(next, chunks[index+1:]...)
	return next
}

var fencePattern = regexp.MustCompile("(?is)^```(?:json)?\\s*\\n?([\\s\\S]*?)\\n?```$")

func (g *generator) call(instruction string, data any) (map[string]any, error) {
	g.calls++
	if g.calls > 512 {
		return nil, aiErr(limitMessage)
	}
	dataLength, err := jsonutil.Len(data)
	if err != nil || dataLength > 60000 {
		return nil, aiErr(limitMessage)
	}
	body := map[string]any{
		"model":           g.ai.cfg.LLM.Model,
		"response_format": map[string]any{"type": "json_object"},
		"max_tokens":      8192,
	}
	encodedData, err := jsonutil.Marshal(data)
	if err != nil {
		return nil, aiErr(limitMessage)
	}
	body["messages"] = []map[string]string{
		{"role": "system", "content": systemPrompt + "\n" + instruction},
		{"role": "user", "content": string(encodedData)},
	}
	if g.ai.cfg.LLM.ReasoningEffort != "" {
		body["reasoning_effort"] = g.ai.cfg.LLM.ReasoningEffort
	}
	for key, value := range g.ai.cfg.LLM.ExtraBody {
		body[key] = value
	}
	payload, err := jsonutil.Marshal(body)
	if err != nil {
		return nil, aiErr(limitMessage)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	endpoint := strings.TrimSuffix(g.ai.cfg.LLM.BaseURL, "/") + "/chat/completions"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, aiErr("模型网络或格式错误，请检查配置并重试")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+g.ai.cfg.LLM.APIKey)
	response, err := g.ai.fetcher(request)
	if err != nil {
		return nil, aiErr("模型网络或格式错误，请检查配置并重试")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, aiErr("模型服务调用失败，请检查服务端配置或稍后重试")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(raw) > 4<<20 {
		return nil, aiErr("模型网络或格式错误，请检查配置并重试")
	}
	if textutil.Len(string(raw)) > 1000000 {
		return nil, aiErr("模型返回过大")
	}
	var envelope struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, aiErr("模型网络或格式错误，请检查配置并重试")
	}
	if len(envelope.Choices) == 0 {
		return nil, &structureError{message: "message.content 缺失或类型错误", output: "null"}
	}
	choice := envelope.Choices[0]
	if choice.FinishReason == "length" {
		return nil, truncatedErr()
	}
	if len(choice.Message.Content) == 0 || bytes.Equal(bytes.TrimSpace(choice.Message.Content), []byte("null")) {
		return nil, &structureError{message: "message.content 缺失或类型错误", output: "null"}
	}
	var content string
	if err := json.Unmarshal(choice.Message.Content, &content); err != nil {
		return nil, &structureError{message: "message.content 缺失或类型错误", output: "null"}
	}
	trimmed := textutil.Trim(content)
	jsonText := fencePattern.ReplaceAllString(trimmed, "$1")
	var decoded any
	if err := jsonutil.Decode([]byte(jsonText), &decoded); err != nil {
		return nil, &structureError{message: "JSON 无效或不是对象", output: content}
	}
	object, ok := decoded.(map[string]any)
	if !ok || object == nil {
		return nil, &structureError{message: "JSON 无效或不是对象", output: content}
	}
	return object, nil
}

// structured calls the model, validates the output, and allows one repair with
// the candidate/error/task. Repair calls share the same global budget.
func (g *generator) structured(stage, instruction string, data any, validate func(map[string]any) (any, error)) (any, error) {
	return g.structuredWithFallback(stage, instruction, data, validate, nil)
}

// structuredWithFallback is structured() with a lenient validator that is used
// only when the repaired output is still structurally invalid. Monthly
// classification uses it to fold unknown theme names into 其他 instead of
// failing the whole month.
func (g *generator) structuredWithFallback(stage, instruction string, data any, validate func(map[string]any) (any, error), fallback func(map[string]any) (any, error)) (any, error) {
	output, err := g.call(instruction, data)
	if err != nil {
		return nil, err
	}
	validated, err := validate(output)
	if err == nil {
		return validated, nil
	}
	var structure *structureError
	if !errors.As(err, &structure) {
		return nil, err
	}
	diagnostic := stage + "结构校验失败：" + structure.message
	candidate := structure.output
	if candidate == nil {
		encoded, marshalErr := jsonutil.Marshal(output)
		if marshalErr != nil {
			return nil, aiErr("生成失败，请稍后重试")
		}
		candidate = string(encoded)
	}
	repaired, repairErr := g.call(instruction+repairSuffix, map[string]any{
		"task":      data,
		"candidate": candidate,
		"error":     diagnostic,
	})
	if repairErr != nil {
		var repairStructure *structureError
		if errors.As(repairErr, &repairStructure) {
			return nil, aiErr(stage + "结构校验失败：" + repairStructure.message)
		}
		return nil, repairErr
	}
	validated, err = validate(repaired)
	if err == nil {
		return validated, nil
	}
	var repairStructure *structureError
	if !errors.As(err, &repairStructure) {
		return nil, err
	}
	if fallback != nil {
		g.warn(stage, "结构", "修复后仍不合规，按宽松规则继续")
		result, fallbackErr := fallback(repaired)
		if fallbackErr != nil {
			var fallbackStructure *structureError
			if errors.As(fallbackErr, &fallbackStructure) {
				return nil, aiErr(stage + "结构校验失败：" + fallbackStructure.message)
			}
			return nil, fallbackErr
		}
		return result, nil
	}
	return nil, aiErr(stage + "结构校验失败：" + repairStructure.message)
}

// warn reports a dropped quote without ever including the quote itself.
func (g *generator) warn(stage, field, message string) {
	g.ai.warnf("%s：%s %s", stage, field, message)
}
