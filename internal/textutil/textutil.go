// Package textutil contains the small set of string helpers whose exact
// behaviour matters for compatibility with the previous Node.js release.
//
// The old server measured limits in JavaScript string length, which counts
// UTF-16 code units. Go counts bytes and runes, so every user-visible limit is
// expressed here in UTF-16 units and never splits a surrogate pair.
package textutil

import (
	"unicode"
	"unicode/utf16"
)

// Len returns the JavaScript-compatible length of s (UTF-16 code units).
func Len(s string) int {
	n := 0
	for _, r := range s {
		n += runeLen(r)
	}
	return n
}

func runeLen(r rune) int {
	if r > 0xffff {
		return 2
	}
	return 1
}

// Truncate returns the longest prefix of s that fits in max UTF-16 units.
// A prefix never contains half of a surrogate pair, matching textBoundary().
func Truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	units := 0
	for i, r := range s {
		width := runeLen(r)
		if units+width > max {
			return s[:i]
		}
		units += width
	}
	return s
}

// PrefixByteIndex returns the byte index for a prefix of at most maxUnits
// UTF-16 units, without splitting a surrogate pair.
func PrefixByteIndex(s string, maxUnits int) int {
	if maxUnits <= 0 {
		return 0
	}
	units := 0
	for i, r := range s {
		width := runeLen(r)
		if units+width > maxUnits {
			return i
		}
		units += width
	}
	return len(s)
}

// Trim removes JavaScript String.prototype.trim() whitespace, including the
// byte-order mark which unicode.IsSpace does not classify as whitespace.
func Trim(s string) string {
	return trimFunc(s, func(r rune) bool { return IsSpace(r) })
}

func trimFunc(s string, space func(rune) bool) string {
	start := 0
	for start < len(s) {
		r, size := decodeRune(s[start:])
		if !space(r) {
			break
		}
		start += size
	}
	end := len(s)
	for end > start {
		r, size := decodeLastRune(s[:end])
		if !space(r) {
			break
		}
		end -= size
	}
	return s[start:end]
}

// IsSpace matches the ECMAScript WhiteSpace and LineTerminator set.
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029,
		0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func decodeRune(s string) (rune, int) {
	for _, r := range s {
		return r, len(string(r))
	}
	return utf16.DecodeRune(0xfffd, 0xfffd), 1
}

func decodeLastRune(s string) (rune, int) {
	var last rune
	size := 1
	for _, r := range s {
		last = r
		size = len(string(r))
	}
	return last, size
}

// Normalize collapses whitespace runs to a single space and optionally maps
// the punctuation the model commonly rewrites. It returns the normalized text
// plus, for every normalized rune, the original rune interval [start,end).
func Normalize(text string, punctuation bool) (string, []int, []int) {
	runes := []rune(text)
	var out []rune
	starts := make([]int, 0, len(runes))
	ends := make([]int, 0, len(runes))
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if IsSpace(r) {
			if len(out) > 0 && out[len(out)-1] == ' ' {
				ends[len(ends)-1] = i + 1
			} else {
				out = append(out, ' ')
				starts = append(starts, i)
				ends = append(ends, i+1)
			}
			continue
		}
		mapped := []rune{mapRune(r, punctuation)}
		for _, m := range mapped {
			out = append(out, m)
			starts = append(starts, i)
			ends = append(ends, i+1)
		}
	}
	return string(out), starts, ends
}

func MapRune(r rune, punctuation bool) rune { return mapRune(r, punctuation) }

// NormalizeString returns only the normalized string.
func NormalizeString(text string, punctuation bool) string {
	value, _, _ := Normalize(text, punctuation)
	return value
}

func mapRune(r rune, punctuation bool) rune {
	if !punctuation {
		return r
	}
	switch r {
	case '。':
		return '.'
	case '、':
		return ','
	case '“', '”':
		return '"'
	case '‘', '’':
		return '\''
	}
	// Fullwidth forms in the ranges the old implementation normalized with
	// NFKC: FF01-FF0F, FF1A-FF20, FF3B-FF40, FF5B-FF5E.
	if (r >= 0xff01 && r <= 0xff0f) ||
		(r >= 0xff1a && r <= 0xff20) ||
		(r >= 0xff3b && r <= 0xff40) ||
		(r >= 0xff5b && r <= 0xff5e) {
		return r - 0xfee0
	}
	return r
}

// IsFullWidthPunctuation reports whether a rune is in the NFKC-normalized
// fullwidth punctuation ranges. Kept for tests and diagnostics.
func IsFullWidthPunctuation(r rune) bool {
	return unicode.IsPunct(r) && mapRune(r, true) != r
}
