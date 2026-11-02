package ai

import (
	"strings"

	"github.com/liangzh77/fleeting/internal/textutil"
)

// monthlyThemes is the fixed monthly taxonomy. The chart is generated from
// these names only, so the number of theme buckets can never exceed this list.
var monthlyThemes = []string{
	"工作与事业",
	"AI与技术",
	"学习与思考",
	"家庭与亲子",
	"人际与沟通",
	"情绪与心理",
	"健康与身体",
	"生活与日常",
	"价值观与自我",
	"其他",
}

var monthlyThemeSet = func() map[string]bool {
	set := make(map[string]bool, len(monthlyThemes))
	for _, theme := range monthlyThemes {
		set[theme] = true
	}
	return set
}()

// Common near-misses are canonicalized instead of creating a new bucket.
// Anything still unknown is repaired once, then folded into 其他.
var monthlyThemeAliases = map[string]string{
	"工作事业":  "工作与事业",
	"AI技术":  "AI与技术",
	"学习思考":  "学习与思考",
	"家庭亲子":  "家庭与亲子",
	"人际沟通":  "人际与沟通",
	"情绪心理":  "情绪与心理",
	"健康身体":  "健康与身体",
	"生活日常":  "生活与日常",
	"价值观自我": "价值观与自我",
	"其它":    "其他",
	"其他主题":  "其他",
}

// canonicalTheme maps model wording to one of the fixed names. It removes all
// whitespace and normalizes fullwidth ASCII, so "AI 与技术" and "ＡＩ与技术"
// both become "AI与技术" rather than separate buckets.
func canonicalTheme(raw string) (string, bool) {
	var builder strings.Builder
	for _, r := range raw {
		if textutil.IsSpace(r) {
			continue
		}
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		}
		builder.WriteRune(r)
	}
	normalized := builder.String()
	if monthlyThemeSet[normalized] {
		return normalized, true
	}
	if alias, ok := monthlyThemeAliases[normalized]; ok {
		return alias, true
	}
	return "", false
}

// capThemes deduplicates while preserving order and keeps at most max themes.
func capThemes(themes []string, max int) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(themes))
	for _, theme := range themes {
		if seen[theme] {
			continue
		}
		seen[theme] = true
		out = append(out, theme)
	}
	if max >= 0 && len(out) > max {
		out = out[:max]
	}
	return out
}
