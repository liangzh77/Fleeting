package textutil

import "testing"

func TestUTF16LengthAndTruncation(t *testing.T) {
	if Len("abc") != 3 || Len("中文") != 2 || Len("😀") != 2 || Len("中文😀") != 4 {
		t.Fatal("UTF-16 length mismatch")
	}
	if got := Truncate("中文😀", 3); got != "中文" {
		t.Fatalf("truncate split surrogate: %q", got)
	}
	if got := Truncate("中文😀", 4); got != "中文😀" {
		t.Fatalf("truncate full: %q", got)
	}
	if got := Truncate("中文😀", 2); got != "中文" {
		t.Fatalf("truncate exact: %q", got)
	}
	if got := PrefixByteIndex("A😀B", 2); got != 1 {
		t.Fatalf("prefix byte index inside surrogate: %d", got)
	}
	if got := PrefixByteIndex("A😀B", 3); got != 5 {
		t.Fatalf("prefix byte index after surrogate: %d", got)
	}
}

func TestTrimAndNormalize(t *testing.T) {
	if got := Trim("\ufeff \t中文\n"); got != "中文" {
		t.Fatalf("trim: %q", got)
	}
	value, starts, ends := Normalize("前缀😀甲\n  乙\t丙　丁后缀", false)
	if value != "前缀😀甲 乙 丙 丁后缀" {
		t.Fatalf("normalized: %q", value)
	}
	if starts[4] != 4 || ends[4] != 7 {
		// The newline + spaces + tab run collapses to one space mapped to 4..7.
		t.Fatalf("mapping: starts=%v ends=%v", starts, ends)
	}
	punctuated := NormalizeString("前缀“甲”，乙！（丙）。后缀", true)
	if punctuated != `前缀"甲",乙!(丙).后缀` {
		t.Fatalf("punctuation: %q", punctuated)
	}
	if NormalizeString("Ａ１２", true) != "Ａ１２" {
		t.Fatal("fullwidth letters/digits must not normalize (matches the old implementation)")
	}
	if NormalizeString("全角！？", true) != "全角!?" {
		t.Fatal("fullwidth punctuation should normalize")
	}
}
