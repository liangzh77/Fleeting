// Package server implements the private single-user HTTP API and static site.
package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/liangzh77/fleeting/internal/ai"
	"github.com/liangzh77/fleeting/internal/auth"
	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/jsonutil"
	"github.com/liangzh77/fleeting/internal/store"
	"github.com/liangzh77/fleeting/internal/textutil"
)

const (
	loginWindow       = 30 * time.Second
	loginMaximum      = 8
	sessionLifetime   = 7 * 24 * time.Hour
	maxRequestBytes   = 32 * 1024
	maxSearchLength   = 200
	maxEntryTextUnits = 8000
)

var idempotencyPattern = regexp.MustCompile(`^[a-zA-Z0-9-]{16,100}$`)

type session struct {
	hash string
	csrf string
}

// Server is the HTTP application.
type Server struct {
	cfg     config.Config
	store   *store.Store
	ai      *ai.AI
	webRoot string
	loc     *time.Location
	secure  bool
	handler http.Handler
}

// New wires the application. It also enforces the password-change session
// revocation and caps lockouts left by older releases, like the Node version.
func New(cfg config.Config, st *store.Store, service *ai.AI, webRoot string) (*Server, error) {
	if !auth.ValidHash(cfg.PasswordHash) {
		return nil, errors.New("尚未设置有效密码哈希，请在 config.local.json 设置 password 或 PASSWORD_HASH 后重启")
	}
	maximumExpiry := time.Now().UnixMilli() + loginWindow.Milliseconds()
	if err := st.CapAttempts(maximumExpiry); err != nil {
		return nil, err
	}
	digest := auth.Digest(cfg.PasswordHash)
	previous, exists, err := st.PasswordDigest()
	if err != nil {
		return nil, err
	}
	if !exists || previous != digest {
		if err := st.ClearSessions(); err != nil {
			return nil, err
		}
		if err := st.SetPasswordDigest(digest); err != nil {
			return nil, err
		}
	}
	s := &Server{
		cfg: cfg, store: st, ai: service, webRoot: webRoot,
		loc: cfg.Location(), secure: strings.HasPrefix(cfg.Origin, "https:"),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api", s.handleAPI)
	mux.HandleFunc("/api/", s.handleAPI)
	mux.HandleFunc("/", s.handleStatic)
	s.handler = secureHeaders(mux, s.secure)
	return s, nil
}

// Handler returns the middleware-wrapped handler.
func (s *Server) Handler() http.Handler { return s.handler }

func secureHeaders(next http.Handler, secure bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("Cache-Control", "no-store")
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("Referrer-Policy", "no-referrer")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if secure {
			header.Set("Strict-Transport-Security", "max-age=31536000")
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("请求处理异常 method=%s path=%s", r.Method, r.URL.Path)
				writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	if !isReadMethod(r.Method) && r.Header.Get("Origin") != s.cfg.Origin {
		writeError(w, http.StatusForbidden, "请求来源不可信")
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/api/login" {
		s.handleLogin(w, r)
		return
	}
	current, ok := s.currentSession(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "请先登录")
		return
	}
	if !isReadMethod(r.Method) && r.Header.Get("X-CSRF-Token") != current.csrf {
		writeError(w, http.StatusForbidden, "安全令牌无效，请刷新后重试")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api")
	switch {
	case r.Method == http.MethodGet && path == "/session":
		s.handleSession(w, r, current)
	case r.Method == http.MethodPost && path == "/logout":
		s.handleLogout(w, r, current)
	case r.Method == http.MethodGet && path == "/dates":
		s.handleDates(w, r)
	case r.Method == http.MethodGet && path == "/entries":
		s.handleEntries(w, r)
	case r.Method == http.MethodPost && path == "/entries":
		s.handleCreateEntry(w, r)
	case strings.HasPrefix(path, "/entries/"):
		id, ok := entryID(path)
		if !ok {
			writeError(w, http.StatusNotFound, "接口不存在")
			return
		}
		switch r.Method {
		case http.MethodGet:
			s.handleGetEntry(w, r, id)
		case http.MethodPut:
			s.handleUpdateEntry(w, r, id)
		case http.MethodDelete:
			s.handleDeleteEntry(w, r, id)
		default:
			writeError(w, http.StatusNotFound, "接口不存在")
		}
	case r.Method == http.MethodGet && path == "/result":
		s.handleResult(w, r)
	case r.Method == http.MethodPost && path == "/generate":
		s.handleGenerate(w, r)
	case r.Method == http.MethodGet && path == "/export":
		s.handleExport(w, r)
	default:
		writeError(w, http.StatusNotFound, "接口不存在")
	}
}

func isReadMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead
}

func entryID(path string) (string, bool) {
	rest := strings.TrimPrefix(path, "/entries/")
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func (s *Server) cookieName() string {
	if s.secure {
		return "__Host-fleeting"
	}
	return "fleeting"
}

func (s *Server) currentSession(r *http.Request) (*session, bool) {
	cookie, err := r.Cookie(s.cookieName())
	if err != nil || cookie.Value == "" {
		return nil, false
	}
	hash := auth.Digest(cookie.Value)
	csrf, ok, err := s.store.FindSession(hash, time.Now().UnixMilli())
	if err != nil || !ok {
		return nil, false
	}
	return &session{hash: hash, csrf: csrf}, true
}

func (s *Server) setSessionCookie(w http.ResponseWriter, value string, maxAge time.Duration) {
	cookie := &http.Cookie{
		Name:     s.cookieName(),
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteStrictMode,
	}
	if maxAge > 0 {
		cookie.MaxAge = int(maxAge.Seconds())
		cookie.Expires = time.Now().Add(maxAge)
	} else {
		cookie.MaxAge = -1
		cookie.Expires = time.Unix(0, 0).UTC()
	}
	http.SetCookie(w, cookie)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	ip := s.clientIP(r)
	now := time.Now()
	blocked, retryAfter, err := s.store.BeginLoginAttempt(ip, now, loginWindow, loginMaximum)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	if blocked {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeError(w, http.StatusTooManyRequests, "尝试过多，请 "+strconv.Itoa(retryAfter)+" 秒后再试")
		return
	}
	password, isString := body["password"].(string)
	if !isString || !auth.VerifyPassword(password, s.cfg.PasswordHash) {
		writeError(w, http.StatusUnauthorized, "密码不正确")
		return
	}
	value, err := auth.Token()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	csrf, err := auth.Token()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	if err := s.store.CreateSession(auth.Digest(value), csrf, now.Add(sessionLifetime).UnixMilli()); err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	s.setSessionCookie(w, value, sessionLifetime)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleSession(w http.ResponseWriter, _ *http.Request, current *session) {
	writeJSON(w, http.StatusOK, map[string]any{
		"csrf":         current.csrf,
		"today":        config.LocalDate(time.Now(), s.loc),
		"timezone":     s.cfg.Timezone,
		"aiConfigured": s.ai.Configured(),
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, _ *http.Request, current *session) {
	if err := s.store.DeleteSession(current.hash); err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	s.setSessionCookie(w, "", 0)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDates(w http.ResponseWriter, _ *http.Request) {
	rows, err := s.store.DB().Query("SELECT day,COUNT(*) AS count FROM entries GROUP BY day ORDER BY day DESC")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var day string
		var count int
		if err := rows.Scan(&day, &count); err != nil {
			writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
			return
		}
		out = append(out, map[string]any{"day": day, "count": count})
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleEntries(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if q, present := query["q"]; present {
		if len(q) != 1 || textutil.Trim(q[0]) == "" || textutil.Len(q[0]) > maxSearchLength {
			writeError(w, http.StatusBadRequest, "搜索词需 1–200 字符")
			return
		}
		rows, err := s.store.DB().Query(
			"SELECT id,text,createdAt,updatedAt,day,version,timeUnknown FROM entries WHERE instr(text,?)>0 ORDER BY createdAt DESC LIMIT 200",
			q[0],
		)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
			return
		}
		defer rows.Close()
		out := []store.Entry{}
		for rows.Next() {
			var entry store.Entry
			if err := rows.Scan(&entry.ID, &entry.Text, &entry.CreatedAt, &entry.UpdatedAt, &entry.Day, &entry.Version, &entry.TimeUnknown); err != nil {
				writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
				return
			}
			out = append(out, entry)
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	day, ok := singleQuery(query, "day")
	if !ok || !config.ValidDay(day) {
		writeError(w, http.StatusBadRequest, "日期无效")
		return
	}
	entries, err := s.store.Entries(day, "day")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func singleQuery(values url.Values, key string) (string, bool) {
	items, present := values[key]
	if !present || len(items) != 1 {
		return "", false
	}
	return items[0], true
}

func (s *Server) handleGetEntry(w http.ResponseWriter, _ *http.Request, id string) {
	entry, err := s.store.Get(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	if entry == nil {
		writeError(w, http.StatusNotFound, "原文已删除")
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleCreateEntry(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Idempotency-Key")
	if !idempotencyPattern.MatchString(key) {
		writeError(w, http.StatusBadRequest, "缺少有效幂等标识")
		return
	}
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	text, ok := textInput(body)
	if !ok {
		writeError(w, http.StatusBadRequest, "原文需 1–8000 字符，不能全为空白")
		return
	}
	entry, replay, err := s.store.Create(text, key, time.Now(), nil)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	status := http.StatusCreated
	if replay {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"entry": entry, "replay": replay})
}

func (s *Server) handleUpdateEntry(w http.ResponseWriter, r *http.Request, id string) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	version, ok := integerValue(body["version"])
	if !ok {
		writeError(w, http.StatusBadRequest, "缺少版本")
		return
	}
	text, ok := textInput(body)
	if !ok {
		writeError(w, http.StatusBadRequest, "原文需 1–8000 字符，不能全为空白")
		return
	}
	entry, err := s.store.Update(id, text, version)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleDeleteEntry(w http.ResponseWriter, r *http.Request, id string) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	version, ok := integerValue(body["version"])
	if !ok {
		writeError(w, http.StatusBadRequest, "缺少版本")
		return
	}
	if err := s.store.Delete(id, version); err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func textInput(body map[string]any) (string, bool) {
	text, ok := body["text"].(string)
	if !ok || textutil.Trim(text) == "" || textutil.Len(text) > maxEntryTextUnits {
		return "", false
	}
	return text, true
}

func integerValue(value any) (int, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	if integer, err := number.Int64(); err == nil {
		return int(integer), true
	}
	float, err := number.Float64()
	if err != nil || math.IsInf(float, 0) || math.IsNaN(float) || float != math.Trunc(float) {
		return 0, false
	}
	if float > math.MaxInt32 || float < math.MinInt32 {
		return 0, false
	}
	return int(float), true
}

func (s *Server) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "记录不存在")
	case errors.Is(err, store.ErrVersionConflict):
		writeError(w, http.StatusConflict, "原文已更新，请刷新后重试")
	case errors.Is(err, store.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "幂等标识已用于其他内容")
	default:
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
	}
}

type resultSource struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
}

type resultData struct {
	Sources []resultSource `json:"sources"`
}

func (s *Server) handleResult(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	kind, okKind := singleQuery(query, "kind")
	period, okPeriod := singleQuery(query, "period")
	if !validScope(kind, period, okKind, okPeriod) {
		writeError(w, http.StatusBadRequest, "日期范围无效")
		return
	}
	job, err := s.store.LatestJob(kind, period)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	ready, err := s.store.LatestReady(kind, period)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	var data json.RawMessage
	var parsed resultData
	hasData := ready != nil && ready.Data != nil && *ready.Data != ""
	if hasData {
		data = json.RawMessage(*ready.Data)
		if err := json.Unmarshal(data, &parsed); err != nil {
			writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
			return
		}
	}
	entries, err := s.store.Entries(period, kind)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	addedOrChanged := false
	removed := false
	if hasData {
		for _, entry := range entries {
			found := false
			for _, source := range parsed.Sources {
				if source.ID == entry.ID && source.Version == entry.Version {
					found = true
					break
				}
			}
			if !found {
				addedOrChanged = true
				break
			}
		}
		for _, source := range parsed.Sources {
			found := false
			for _, entry := range entries {
				if entry.ID == source.ID {
					found = true
					break
				}
			}
			if !found {
				removed = true
				break
			}
		}
	}
	change := "none"
	switch {
	case addedOrChanged && removed:
		change = "mixed"
	case addedOrChanged:
		change = "added"
	case removed:
		change = "removed"
	}
	var state any
	if job != nil {
		state = job.State
	}
	var jobError any
	if job != nil && job.State == "failed" && job.Error != nil {
		jobError = *job.Error
	}
	var model any
	var generatedAt any
	if ready != nil {
		model = ready.Model
		generatedAt = ready.GeneratedAt
	} else if job != nil {
		model = job.Model
	}
	outdated := hasData && s.store.Snapshot(entries) != ready.Fingerprint
	var dataValue any
	if hasData {
		dataValue = data
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"kind":        kind,
		"period":      period,
		"state":       state,
		"error":       jobError,
		"data":        dataValue,
		"model":       model,
		"generatedAt": generatedAt,
		"outdated":    outdated,
		"change":      change,
	})
}

func validScope(kind, period string, okKind, okPeriod bool) bool {
	if !okKind || !okPeriod {
		return false
	}
	return (kind == "day" && config.ValidDay(period)) ||
		(kind == "month" && config.ValidMonth(period))
}

func (s *Server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	kind, _ := body["kind"].(string)
	period, _ := body["period"].(string)
	if !validScope(kind, period, body["kind"] != nil, body["period"] != nil) {
		writeError(w, http.StatusBadRequest, "日期范围无效")
		return
	}
	if consent, isBool := body["consent"].(bool); !isBool || !consent {
		writeError(w, http.StatusBadRequest, "请先确认向模型服务商发送所选原文")
		return
	}
	if err := s.ai.Generate(kind, period, ""); err != nil {
		if message, isAI := ai.PublicMessage(err); isAI {
			writeError(w, http.StatusServiceUnavailable, message)
			return
		}
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	day, hasDay := "", false
	if values, present := query["day"]; present {
		if len(values) != 1 || !config.ValidDay(values[0]) {
			writeError(w, http.StatusBadRequest, "日期无效")
			return
		}
		day, hasDay = values[0], true
	}
	format, _ := singleQuery(query, "format")
	markdown := format == "markdown"
	var (
		entries []store.Entry
		err     error
	)
	if hasDay {
		entries, err = s.store.Entries(day, "day")
	} else {
		entries, err = allEntries(s.store.DB())
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "服务暂不可用，请稍后重试")
		return
	}
	label := day
	if label == "" {
		label = "all"
	}
	extension := "json"
	if markdown {
		extension = "md"
	}
	w.Header().Set("Content-Disposition", `attachment; filename="fleeting-`+label+`.`+extension+`"`)
	if markdown {
		var builder strings.Builder
		for index, entry := range entries {
			if index > 0 {
				builder.WriteString("\n")
			}
			builder.WriteString("## ")
			builder.WriteString(entry.Day)
			builder.WriteString(" · ")
			if entry.TimeUnknown != 0 {
				builder.WriteString("补录 · 时间未记录")
			} else {
				parsed, parseErr := time.Parse(time.RFC3339Nano, entry.CreatedAt)
				if parseErr == nil {
					builder.WriteString(parsed.In(s.loc).Format("15:04"))
				}
			}
			builder.WriteString("\n\n")
			builder.WriteString(entry.Text)
			builder.WriteString("\n")
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, builder.String())
		return
	}
	if entries == nil {
		entries = []store.Entry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"formatVersion": 1,
		"timezone":      s.cfg.Timezone,
		"exportedAt":    config.FormatISO(time.Now()),
		"entries":       entries,
	})
}

func allEntries(db *sql.DB) ([]store.Entry, error) {
	rows, err := db.Query("SELECT id,text,createdAt,updatedAt,day,version,timeUnknown FROM entries ORDER BY createdAt,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.Entry{}
	for rows.Next() {
		var entry store.Entry
		if err := rows.Scan(&entry.ID, &entry.Text, &entry.CreatedAt, &entry.UpdatedAt, &entry.Day, &entry.Version, &entry.TimeUnknown); err != nil {
			return nil, err
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	requestPath := r.URL.Path
	if requestPath == "" {
		requestPath = "/"
	}
	cleaned := filepath.Clean("/" + requestPath)
	relative := strings.TrimPrefix(cleaned, "/")
	if relative == "" {
		relative = "index.html"
	}
	root, err := filepath.Abs(s.webRoot)
	if err != nil {
		http.Error(w, "页面不可用", http.StatusInternalServerError)
		return
	}
	target := filepath.Join(root, filepath.FromSlash(relative))
	if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(target)
	if err == nil && info.IsDir() {
		target = filepath.Join(target, "index.html")
		info, err = os.Stat(target)
	}
	if err != nil || info.IsDir() {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "Cannot GET "+r.URL.Path)
		return
	}
	http.ServeFile(w, r, target)
}

func (s *Server) decodeBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	contentType := r.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		return map[string]any{}, true
	}
	reader := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	raw, err := io.ReadAll(reader)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "请求过大")
		} else {
			writeError(w, http.StatusBadRequest, "请求格式无效")
		}
		return nil, false
	}
	if len(strings.TrimSpace(string(raw))) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return map[string]any{}, true
	}
	var decoded any
	if err := jsonutil.Decode(raw, &decoded); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式无效")
		return nil, false
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return map[string]any{}, true
	}
	return object, true
}

func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			first := strings.TrimSpace(strings.Split(forwarded, ",")[0])
			if first != "" {
				return textutil.Truncate(first, 64)
			}
		}
	}
	return textutil.Truncate(host, 64)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	encoded, err := jsonutil.Marshal(value)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":"服务暂不可用，请稍后重试"}`)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}
