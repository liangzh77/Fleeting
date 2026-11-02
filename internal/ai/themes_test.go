package ai

import "testing"

func TestCanonicalThemeNames(t *testing.T) {
	cases := map[string]string{
		"AI 与技术":  "AI与技术",
		"ＡＩ与技术":   "AI与技术",
		"工作事业":    "工作与事业",
		"生活与日常":   "生活与日常",
		"其它":      "其他",
		"家庭 与 亲子": "家庭与亲子",
		"情绪与心理":   "情绪与心理",
	}
	for input, want := range cases {
		got, ok := canonicalTheme(input)
		if !ok || got != want {
			t.Errorf("canonicalTheme(%q) = %q, %v; want %q", input, got, ok, want)
		}
	}
	if _, ok := canonicalTheme("不存在的主题"); ok {
		t.Fatal("unknown theme accepted")
	}
}

func TestCapThemesDeduplicatesAndCaps(t *testing.T) {
	got := capThemes([]string{"工作与事业", "工作与事业", "AI与技术", "学习与思考"}, 2)
	if len(got) != 2 || got[0] != "工作与事业" || got[1] != "AI与技术" {
		t.Fatalf("capThemes: %v", got)
	}
	if got := capThemes([]string{}, 2); len(got) != 0 {
		t.Fatalf("empty themes: %v", got)
	}
}

func TestThemeCountsUniqueSources(t *testing.T) {
	themes := ThemeCounts([]Classification{
		{ID: "a", Themes: []string{"工作与事业", "AI与技术", "工作与事业"}},
		{ID: "b", Themes: []string{"工作与事业", "学习与思考"}},
	})
	want := []struct {
		name  string
		count int
	}{
		{"工作与事业", 2},
		{"AI与技术", 1},
		{"学习与思考", 1},
	}
	if len(themes) != len(want) {
		t.Fatalf("themes: %+v", themes)
	}
	for index, expected := range want {
		if themes[index].Name != expected.name || themes[index].Count != expected.count {
			t.Fatalf("theme[%d]=%+v want %+v", index, themes[index], expected)
		}
	}
}

func TestMonthlyThemeListHasTenNames(t *testing.T) {
	if len(monthlyThemes) != 10 {
		t.Fatalf("monthly theme count=%d", len(monthlyThemes))
	}
}
