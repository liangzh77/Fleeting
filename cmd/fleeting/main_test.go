package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneBackupsRemovesOldestOnly(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	names := []string{
		"fleeting-2026-10-30.sqlite",
		"fleeting-2026-10-31.sqlite",
		"fleeting-2026-11-01.sqlite",
		"fleeting-2026-11-02.sqlite",
		"fleeting-2026-11-03.sqlite",
	}
	for index, name := range names {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := base.Add(time.Duration(index) * time.Hour)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "unrelated.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	pruned, err := pruneBackups(dir, 3)
	if err != nil || pruned != 2 {
		t.Fatalf("pruned=%d err=%v", pruned, err)
	}
	for index, name := range names {
		_, err := os.Stat(filepath.Join(dir, name))
		if index < 2 && !os.IsNotExist(err) {
			t.Errorf("old backup kept: %s", name)
		}
		if index >= 2 && err != nil {
			t.Errorf("recent backup removed: %s (%v)", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "unrelated.txt")); err != nil {
		t.Fatal("unrelated file removed")
	}
	pruned, err = pruneBackups(dir, 0)
	if err != nil || pruned != 3 {
		t.Fatalf("keep=0 pruned=%d err=%v", pruned, err)
	}
}
