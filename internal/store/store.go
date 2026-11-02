// Package store owns the SQLite database. The schema is deliberately identical
// to the Node.js release so an existing database can be opened in place.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/liangzh77/fleeting/internal/auth"
	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/jsonutil"
	_ "modernc.org/sqlite"
)

// Entry is one original note.
type Entry struct {
	ID          string `json:"id"`
	Text        string `json:"text"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
	Day         string `json:"day"`
	Version     int    `json:"version"`
	TimeUnknown int    `json:"timeUnknown"`
}

// Result is one AI job / successful result row.
type Result struct {
	ID          string
	Kind        string
	Period      string
	State       string
	Fingerprint string
	Data        *string
	Model       string
	GeneratedAt string
	Error       *string
}

var (
	ErrNotFound            = errors.New("NOT_FOUND")
	ErrVersionConflict     = errors.New("VERSION_CONFLICT")
	ErrIdempotencyConflict = errors.New("IDEMPOTENCY_CONFLICT")
	ErrInvalidDay          = errors.New("日期无效")
	ErrAlreadyRunning      = errors.New("已有生成进行中，请稍后重试")
	ErrAutoAttempted       = errors.New("本日自动整理已尝试")
)

// Store wraps the single SQLite connection used by the process.
type Store struct {
	db      *sql.DB
	path    string
	tz      string
	loc     *time.Location
	writeMu sync.Mutex
}

// Open opens (and creates or migrates) the database. markInterruptedJobs turns
// any running AI task left by a previous process into a failed task.
func Open(path, timezone string, markInterruptedJobs bool) (*Store, error) {
	if path != ":memory:" {
		if err := config.EnsureDatabaseDir(path); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	s := &Store{db: db, path: path, tz: timezone}
	s.loc, err = time.LoadLocation(timezone)
	if err != nil {
		db.Close()
		return nil, errors.New("数据库时区无效")
	}
	if err := s.initialize(markInterruptedJobs); err != nil {
		db.Close()
		return nil, err
	}
	if path != ":memory:" {
		if err := os.Chmod(path, 0o600); err != nil {
			db.Close()
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) initialize(markInterruptedJobs bool) error {
	for _, statement := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
		`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,text TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,day TEXT NOT NULL,version INTEGER NOT NULL,timeUnknown INTEGER NOT NULL DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS entries_day ON entries(day,createdAt)`,
		`CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,bodyHash TEXT NOT NULL,entryId TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,kind TEXT NOT NULL,period TEXT NOT NULL,state TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT,model TEXT NOT NULL,generatedAt TEXT NOT NULL,error TEXT)`,
	} {
		if err := s.exec(statement); err != nil {
			return err
		}
	}
	// Older databases predate date-only imports.
	columns, err := s.tableColumns("entries")
	if err != nil {
		return err
	}
	if !contains(columns, "timeUnknown") {
		if err := s.exec("ALTER TABLE entries ADD COLUMN timeUnknown INTEGER NOT NULL DEFAULT 0"); err != nil {
			return err
		}
	}
	// Legacy stale rows already had their derived content cleared.
	if err := s.exec("DELETE FROM results WHERE state='stale'"); err != nil {
		return err
	}
	var stored string
	err = s.db.QueryRow("SELECT value FROM meta WHERE key=?", "timezone").Scan(&stored)
	switch {
	case err == nil:
		if stored != s.tz {
			return errors.New("数据库时区已固定；更改时区需显式迁移")
		}
	case errors.Is(err, sql.ErrNoRows):
		if _, err := s.db.Exec("INSERT INTO meta VALUES (?,?)", "timezone", s.tz); err != nil {
			return err
		}
	default:
		return err
	}
	if markInterruptedJobs {
		if _, err := s.db.Exec("UPDATE results SET state='failed',error='服务重启，生成中断' WHERE state='running'"); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) exec(statement string) error {
	_, err := s.db.Exec(statement)
	return err
}

func (s *Store) tableColumns(table string) ([]string, error) {
	rows, err := s.db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// DB exposes the underlying connection for narrow read-only queries.
func (s *Store) DB() *sql.DB { return s.db }

// Location returns the fixed archive location.
func (s *Store) Location() *time.Location { return s.loc }

// Timezone returns the fixed archive timezone name.
func (s *Store) Timezone() string { return s.tz }

// Path returns the database path.
func (s *Store) Path() string { return s.path }

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// RunTx serializes and runs a write transaction. The single-connection pool plus
// writeMu keep BEGIN/COMMIT free of interleaving.
func (s *Store) RunTx(ctx context.Context, fn func(*sql.Tx) error) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	done := false
	defer func() {
		if !done {
			_ = tx.Rollback()
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	done = true
	return nil
}

// Entries returns entries for a day or a month, oldest first.
func (s *Store) Entries(period, kind string) ([]Entry, error) {
	query := "SELECT id,text,createdAt,updatedAt,day,version,timeUnknown FROM entries WHERE day=? ORDER BY createdAt,id"
	arg := period
	if kind == "month" {
		query = "SELECT id,text,createdAt,updatedAt,day,version,timeUnknown FROM entries WHERE substr(day,1,7)=? ORDER BY createdAt,id"
	}
	rows, err := s.db.Query(query, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Entry, 0)
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.Text, &e.CreatedAt, &e.UpdatedAt, &e.Day, &e.Version, &e.TimeUnknown); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Get returns one entry by id.
func (s *Store) Get(id string) (*Entry, error) {
	var e Entry
	err := s.db.QueryRow("SELECT id,text,createdAt,updatedAt,day,version,timeUnknown FROM entries WHERE id=?", id).
		Scan(&e.ID, &e.Text, &e.CreatedAt, &e.UpdatedAt, &e.Day, &e.Version, &e.TimeUnknown)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func getEntry(tx *sql.Tx, id string) (*Entry, error) {
	var e Entry
	err := tx.QueryRow("SELECT id,text,createdAt,updatedAt,day,version,timeUnknown FROM entries WHERE id=?", id).
		Scan(&e.ID, &e.Text, &e.CreatedAt, &e.UpdatedAt, &e.Day, &e.Version, &e.TimeUnknown)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// Snapshot hashes the id/version list, matching the old JSON.stringify shape.
func (s *Store) Snapshot(entries []Entry) string {
	pairs := make([][]any, 0, len(entries))
	for _, e := range entries {
		pairs = append(pairs, []any{e.ID, e.Version})
	}
	data, err := jsonutil.Marshal(pairs)
	if err != nil {
		return auth.Digest("[]")
	}
	return auth.Digest(string(data))
}

// Create stores a note idempotently. archiveDay is optional (date-only import).
func (s *Store) Create(text, key string, now time.Time, archiveDay *string) (*Entry, bool, error) {
	if archiveDay != nil && !config.ValidDay(*archiveDay) {
		return nil, false, ErrInvalidDay
	}
	var entry *Entry
	replay := false
	err := s.RunTx(context.Background(), func(tx *sql.Tx) error {
		var bodyHash, entryID string
		err := tx.QueryRow("SELECT bodyHash,entryId FROM requests WHERE key=?", key).Scan(&bodyHash, &entryID)
		if err == nil {
			if bodyHash != auth.Digest(text) {
				return ErrIdempotencyConflict
			}
			previous, err := getEntry(tx, entryID)
			if err != nil {
				return err
			}
			entry = previous
			replay = true
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		id, err := auth.NewUUID()
		if err != nil {
			return err
		}
		created := config.FormatISO(now)
		day := config.LocalDate(now, s.loc)
		timeUnknown := 0
		if archiveDay != nil {
			day = *archiveDay
			timeUnknown = 1
		}
		if _, err := tx.Exec(
			"INSERT INTO entries(id,text,createdAt,updatedAt,day,version,timeUnknown) VALUES (?,?,?,?,?,?,?)",
			id, text, created, created, day, 1, timeUnknown,
		); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO requests VALUES (?,?,?)", key, auth.Digest(text), id); err != nil {
			return err
		}
		entry = &Entry{
			ID: id, Text: text, CreatedAt: created, UpdatedAt: created,
			Day: day, Version: 1, TimeUnknown: timeUnknown,
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return entry, replay, nil
}

// Update modifies an entry with optimistic version checking.
func (s *Store) Update(id, text string, version int) (*Entry, error) {
	var entry *Entry
	err := s.RunTx(context.Background(), func(tx *sql.Tx) error {
		current, err := getEntry(tx, id)
		if err != nil {
			return err
		}
		if current == nil {
			return ErrNotFound
		}
		if current.Version != version {
			return ErrVersionConflict
		}
		if _, err := tx.Exec("UPDATE entries SET text=?,updatedAt=?,version=version+1 WHERE id=?",
			text, config.FormatISO(time.Now()), id); err != nil {
			return err
		}
		updated, err := getEntry(tx, id)
		if err != nil {
			return err
		}
		entry = updated
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entry, nil
}

// Delete removes an entry with optimistic version checking.
func (s *Store) Delete(id string, version int) error {
	return s.RunTx(context.Background(), func(tx *sql.Tx) error {
		current, err := getEntry(tx, id)
		if err != nil {
			return err
		}
		if current == nil {
			return ErrNotFound
		}
		if current.Version != version {
			return ErrVersionConflict
		}
		_, err = tx.Exec("DELETE FROM entries WHERE id=?", id)
		return err
	})
}

func scanResult(scanner interface {
	Scan(dest ...any) error
}) (*Result, error) {
	var r Result
	var data, errText sql.NullString
	if err := scanner.Scan(&r.ID, &r.Kind, &r.Period, &r.State, &r.Fingerprint, &data, &r.Model, &r.GeneratedAt, &errText); err != nil {
		return nil, err
	}
	if data.Valid {
		value := data.String
		r.Data = &value
	}
	if errText.Valid {
		value := errText.String
		r.Error = &value
	}
	return &r, nil
}

const resultColumns = "id,kind,period,state,fingerprint,data,model,generatedAt,error"

// LatestReady returns the newest successful result for a scope.
func (s *Store) LatestReady(kind, period string) (*Result, error) {
	row := s.db.QueryRow(
		"SELECT "+resultColumns+" FROM results WHERE kind=? AND period=? AND state='ready' AND data IS NOT NULL ORDER BY rowid DESC LIMIT 1",
		kind, period,
	)
	result, err := scanResult(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return result, err
}

// LatestJob returns the newest job (any state) for a scope.
func (s *Store) LatestJob(kind, period string) (*Result, error) {
	row := s.db.QueryRow(
		"SELECT "+resultColumns+" FROM results WHERE kind=? AND period=? ORDER BY rowid DESC LIMIT 1",
		kind, period,
	)
	result, err := scanResult(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return result, err
}

// HasRunning reports whether a scope currently has a running job.
func (s *Store) HasRunning(kind, period string) (bool, error) {
	var id string
	err := s.db.QueryRow("SELECT id FROM results WHERE state='running' AND kind=? AND period=?", kind, period).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ClaimResult atomically checks the running scope (and the optional automatic
// attempt marker) and inserts a running row.
func (s *Store) ClaimResult(id, kind, period, fingerprint, model, generatedAt, automaticDay string) error {
	return s.RunTx(context.Background(), func(tx *sql.Tx) error {
		var existing string
		err := tx.QueryRow("SELECT id FROM results WHERE kind=? AND period=? AND state='running'", kind, period).Scan(&existing)
		if err == nil {
			return ErrAlreadyRunning
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if automaticDay != "" {
			key := "auto-day:" + automaticDay
			var value string
			err := tx.QueryRow("SELECT value FROM meta WHERE key=?", key).Scan(&value)
			if err == nil {
				return ErrAutoAttempted
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if _, err := tx.Exec("INSERT INTO meta VALUES (?,?)", key, period); err != nil {
				return err
			}
		}
		_, err = tx.Exec(
			"INSERT INTO results VALUES (?,?,?,?,?,?,?,?,NULL)",
			id, kind, period, "running", fingerprint, nil, model, generatedAt,
		)
		return err
	})
}

// SaveReady stores a validated result.
func (s *Store) SaveReady(id, data, generatedAt string) error {
	_, err := s.db.Exec("UPDATE results SET state='ready',data=?,generatedAt=? WHERE id=?", data, generatedAt, id)
	return err
}

// SaveFailed marks a running job as failed and discards partial data.
func (s *Store) SaveFailed(id, message string) error {
	_, err := s.db.Exec("UPDATE results SET state='failed',error=?,data=NULL WHERE id=?", message, id)
	return err
}

// MetaHas reports whether a meta key exists.
func (s *Store) MetaHas(key string) (bool, error) {
	var value string
	err := s.db.QueryRow("SELECT value FROM meta WHERE key=?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// MetaGet returns a meta value.
func (s *Store) MetaGet(key string) (string, bool, error) {
	var value string
	err := s.db.QueryRow("SELECT value FROM meta WHERE key=?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// SetMeta inserts or replaces a meta value.
func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", key, value)
	return err
}

// BeginLoginAttempt atomically cleans expired rows, enforces the per-IP limit
// and counts the attempt before the expensive password hash runs.
func (s *Store) BeginLoginAttempt(ip string, now time.Time, window time.Duration, maximum int) (blocked bool, retryAfter int, err error) {
	nowMillis := now.UnixMilli()
	until := nowMillis + window.Milliseconds()
	err = s.RunTx(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM attempts WHERE until<?", nowMillis); err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM sessions WHERE expires<?", nowMillis); err != nil {
			return err
		}
		var count int
		var attemptUntil int64
		scanErr := tx.QueryRow("SELECT count,until FROM attempts WHERE ip=?", ip).Scan(&count, &attemptUntil)
		if scanErr != nil && !errors.Is(scanErr, sql.ErrNoRows) {
			return scanErr
		}
		if scanErr == nil && count >= maximum {
			seconds := int((attemptUntil - nowMillis + 999) / 1000)
			if seconds < 1 {
				seconds = 1
			}
			blocked = true
			retryAfter = seconds
			return nil
		}
		_, err := tx.Exec(
			"INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(ip) DO UPDATE SET count=count+1",
			ip, until,
		)
		return err
	})
	return blocked, retryAfter, err
}

// CapAttempts shortens lockouts left by older releases.
func (s *Store) CapAttempts(maximumExpiry int64) error {
	_, err := s.db.Exec("UPDATE attempts SET until=? WHERE until>?", maximumExpiry, maximumExpiry)
	return err
}

// CreateSession stores a hashed session token.
func (s *Store) CreateSession(hash, csrf string, expires int64) error {
	_, err := s.db.Exec("INSERT INTO sessions VALUES (?,?,?)", hash, csrf, expires)
	return err
}

// FindSession returns the CSRF token for a live session.
func (s *Store) FindSession(hash string, now int64) (string, bool, error) {
	var csrf string
	err := s.db.QueryRow("SELECT csrf FROM sessions WHERE hash=? AND expires>?", hash, now).Scan(&csrf)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return csrf, true, nil
}

// DeleteSession removes one session.
func (s *Store) DeleteSession(hash string) error {
	_, err := s.db.Exec("DELETE FROM sessions WHERE hash=?", hash)
	return err
}

// ClearSessions revokes every session (used when the password hash changes).
func (s *Store) ClearSessions() error {
	_, err := s.db.Exec("DELETE FROM sessions")
	return err
}

// PasswordDigest returns the stored digest of the password hash.
func (s *Store) PasswordDigest() (string, bool, error) {
	return s.MetaGet("password")
}

// SetPasswordDigest records the password hash digest.
func (s *Store) SetPasswordDigest(digest string) error {
	return s.SetMeta("password", digest)
}

// Diagnostics returns a short, non-sensitive data summary.
func (s *Store) Diagnostics() (map[string]any, error) {
	out := map[string]any{}
	for _, table := range []string{"entries", "results", "sessions"} {
		var count int
		if err := s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil {
			return nil, fmt.Errorf("%s: %w", table, err)
		}
		out[table] = count
	}
	rows, err := s.db.Query("SELECT day,count(*) FROM entries GROUP BY day ORDER BY day")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	days := make([]map[string]any, 0)
	for rows.Next() {
		var day string
		var count int
		if err := rows.Scan(&day, &count); err != nil {
			return nil, err
		}
		days = append(days, map[string]any{"day": day, "count": count})
	}
	out["days"] = days
	return out, rows.Err()
}

// Backup writes a consistent snapshot using VACUUM INTO. The destination must
// not exist; the file is created with 0600 permissions.
func Backup(database, destination string) error {
	if database == ":memory:" {
		return errors.New("内存数据库不支持备份")
	}
	if _, err := os.Stat(destination); err == nil {
		return errors.New("备份目标已存在")
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", database)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return err
	}
	escaped := strings.ReplaceAll(destination, "'", "''")
	if _, err := db.Exec("VACUUM INTO '" + escaped + "'"); err != nil {
		return err
	}
	return os.Chmod(destination, 0o600)
}
