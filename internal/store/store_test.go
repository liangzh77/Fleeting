package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/liangzh77/fleeting/internal/auth"
	_ "modernc.org/sqlite"
)

func TestMidnightBoundaryAndEntryOrder(t *testing.T) {
	st, err := Open(":memory:", "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	before, _ := time.Parse(time.RFC3339, "2026-10-06T15:59:59Z")
	after, _ := time.Parse(time.RFC3339, "2026-10-06T16:00:00Z")
	if _, _, err := st.Create("午夜前", "boundary-before", before, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.Create("午夜后", "boundary-after", after, nil); err != nil {
		t.Fatal(err)
	}
	if entries, _ := st.Entries("2026-10-06", "day"); len(entries) != 1 || entries[0].Text != "午夜前" {
		t.Fatalf("before midnight: %+v", entries)
	}
	if entries, _ := st.Entries("2026-10-07", "day"); len(entries) != 1 || entries[0].Text != "午夜后" {
		t.Fatalf("after midnight: %+v", entries)
	}
	if entries, _ := st.Entries("2026-10", "month"); len(entries) != 2 {
		t.Fatalf("month: %+v", entries)
	}
}

func TestCreateIdempotencyVersionAndDelete(t *testing.T) {
	st, err := Open(":memory:", "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	text := "原文 <script>alert(1)</script>"
	entry, replay, err := st.Create(text, "test-idempotency-key-0001", time.Now(), nil)
	if err != nil || replay || entry == nil {
		t.Fatalf("create: %+v %v %v", entry, replay, err)
	}
	again, replay, err := st.Create(text, "test-idempotency-key-0001", time.Now(), nil)
	if err != nil || !replay || again == nil || again.ID != entry.ID {
		t.Fatalf("replay: %+v %v %v", again, replay, err)
	}
	if _, _, err := st.Create("different", "test-idempotency-key-0001", time.Now(), nil); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflict: %v", err)
	}
	if _, err := st.Update(entry.ID, "modified", 2); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("version conflict: %v", err)
	}
	updated, err := st.Update(entry.ID, "modified", 1)
	if err != nil || updated.Text != "modified" || updated.Version != 2 {
		t.Fatalf("update: %+v %v", updated, err)
	}
	if _, err := st.Update("missing", "x", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing update: %v", err)
	}
	if err := st.Delete(entry.ID, 1); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("delete conflict: %v", err)
	}
	if err := st.Delete(entry.ID, 2); err != nil {
		t.Fatal(err)
	}
	replayed, replay, err := st.Create(text, "test-idempotency-key-0001", time.Now(), nil)
	if err != nil || !replay || replayed != nil {
		t.Fatalf("deleted replay: %+v %v %v", replayed, replay, err)
	}
}

func TestLegacyMigrationArchiveDayAndTimezoneLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "old.sqlite")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy.SetMaxOpenConns(1)
	if _, err := legacy.Exec("CREATE TABLE entries(id TEXT PRIMARY KEY,text TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,day TEXT NOT NULL,version INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	st, err := Open(path, "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	columns, err := st.tableColumns("entries")
	if err != nil {
		t.Fatal(err)
	}
	if !contains(columns, "timeUnknown") {
		t.Fatal("timeUnknown column missing")
	}
	day := "2026-10-04"
	clock, _ := time.Parse(time.RFC3339, "2026-10-07T05:00:00Z")
	entry, replay, err := st.Create("补录原文，不知道具体几点。", "date-only-test-key", clock, &day)
	if err != nil || replay || entry == nil || entry.Day != day || entry.TimeUnknown != 1 || entry.CreatedAt != "2026-10-07T05:00:00.000Z" {
		t.Fatalf("archive: %+v %v %v", entry, replay, err)
	}
	if _, replay, _ := st.Create("补录原文，不知道具体几点。", "date-only-test-key", time.Now(), &day); !replay {
		t.Fatal("date-only replay should be idempotent")
	}
	if entries, _ := st.Entries(day, "day"); len(entries) != 1 {
		t.Fatalf("archive entries: %+v", entries)
	}
	invalid := "2026-02-30"
	if _, _, err := st.Create("bad", "bad-date-key", time.Now(), &invalid); !errors.Is(err, ErrInvalidDay) {
		t.Fatalf("invalid archive day: %v", err)
	}
	st.Close()
	if _, err := Open(path, "UTC", true); err == nil {
		t.Fatal("timezone change must be rejected")
	}
}

func TestReopenMarksRunningFailedAndDropsStale(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db.sqlite")
	st, err := Open(path, "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	entry, _, err := st.Create("持久化恢复样例", "persistence-entry", time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)",
		"previous-ready", "day", entry.Day, "ready", "snapshot", `{"sections":[],"sources":[]}`, "mock", "2026-10-07T00:00:00.000Z", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)",
		"legacy-stale", "day", entry.Day, "stale", "snapshot", nil, "mock", "2026-10-07T00:00:00.000Z", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)",
		"restart-job", "day", entry.Day, "running", "snapshot", nil, "mock", "2026-10-07T00:00:00.000Z", nil); err != nil {
		t.Fatal(err)
	}
	st.Close()

	reopened, err := Open(path, "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, _ := reopened.Get(entry.ID)
	if got == nil || got.Text != entry.Text {
		t.Fatal("entry lost on reopen")
	}
	job, _ := reopened.LatestJob("day", entry.Day)
	if job == nil || job.State != "failed" {
		t.Fatalf("running job not failed: %+v", job)
	}
	ready, _ := reopened.LatestReady("day", entry.Day)
	if ready == nil || ready.Data == nil || *ready.Data != `{"sections":[],"sources":[]}` {
		t.Fatalf("ready result lost: %+v", ready)
	}
	var count int
	if err := reopened.DB().QueryRow("SELECT count(*) FROM results WHERE state='stale'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("stale rows: %d %v", count, err)
	}
}

func TestSnapshotShape(t *testing.T) {
	st, err := Open(":memory:", "UTC", true)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	got := st.Snapshot([]Entry{{ID: "a", Version: 1}, {ID: "b", Version: 2}})
	want := auth.Digest(`[["a",1],["b",2]]`)
	if got != want {
		t.Fatalf("snapshot %s want %s", got, want)
	}
}

func TestBackupRestoresData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db.sqlite")
	st, err := Open(path, "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	entry, _, err := st.Create("备份恢复样例", "backup-entry", time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	target := filepath.Join(dir, "backup.sqlite")
	if err := Backup(path, target); err != nil {
		t.Fatal(err)
	}
	if err := Backup(path, target); err == nil {
		t.Fatal("existing destination should fail")
	}
	restored, err := Open(target, "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	got, _ := restored.Get(entry.ID)
	if got == nil || got.Text != "备份恢复样例" {
		t.Fatalf("restored entry: %+v", got)
	}
}

func TestLoginAttemptsAndSessions(t *testing.T) {
	st, err := Open(":memory:", "Asia/Shanghai", true)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Now()
	for i := 0; i < 8; i++ {
		blocked, _, err := st.BeginLoginAttempt("203.0.113.9", now, 30*time.Second, 8)
		if err != nil || blocked {
			t.Fatalf("attempt %d: %v %v", i, blocked, err)
		}
	}
	blocked, retry, err := st.BeginLoginAttempt("203.0.113.9", now, 30*time.Second, 8)
	if err != nil || !blocked || retry < 1 || retry > 30 {
		t.Fatalf("blocked: %v %d %v", blocked, retry, err)
	}
	var count int
	if err := st.DB().QueryRow("SELECT count FROM attempts WHERE ip=?", "203.0.113.9").Scan(&count); err != nil || count != 8 {
		t.Fatalf("blocked attempt must not increment: %d %v", count, err)
	}
	if err := st.CapAttempts(now.Add(30 * time.Second).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var until int64
	if err := st.DB().QueryRow("SELECT until FROM attempts").Scan(&until); err != nil || until > now.Add(30*time.Second).UnixMilli()+1000 {
		t.Fatalf("cap attempts: %d %v", until, err)
	}
	if err := st.CreateSession(auth.Digest("token"), "csrf", now.Add(time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	csrf, ok, err := st.FindSession(auth.Digest("token"), now.UnixMilli())
	if err != nil || !ok || csrf != "csrf" {
		t.Fatalf("session: %q %v %v", csrf, ok, err)
	}
	if _, ok, _ := st.FindSession(auth.Digest("token"), now.Add(2*time.Hour).UnixMilli()); ok {
		t.Fatal("expired session accepted")
	}
	if err := st.DeleteSession(auth.Digest("token")); err != nil {
		t.Fatal(err)
	}
}
