package ai

import (
	"sort"
	"strings"

	"github.com/liangzh77/fleeting/internal/jsonutil"
	"github.com/liangzh77/fleeting/internal/store"
	"github.com/liangzh77/fleeting/internal/textutil"
)

type suppliedText struct {
	ID   string `json:"id"`
	Day  string `json:"day"`
	Text string `json:"text"`
}

type review struct {
	Overview    string     `json:"overview"`
	Insights    []Insight  `json:"insights"`
	Changes     []Insight  `json:"changes"`
	Connections []Insight  `json:"connections"`
	Questions   []Question `json:"questions"`
}

type dailyOutput struct {
	Sections []DailySection `json:"sections"`
}

func strValue(value any, max int, field string) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", &structureError{message: field + " 缺失或类型错误"}
	}
	truncated := textutil.Truncate(text, max)
	if textutil.Trim(truncated) == "" {
		return "", &structureError{message: field + " 为空"}
	}
	return truncated, nil
}

func arrayValue(value any, max int, field string) ([]any, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, &structureError{message: field + " 缺失或类型错误"}
	}
	if len(items) > 2000 {
		return nil, &structureError{message: field + " 超过2000项"}
	}
	if len(items) > max {
		items = items[:max]
	}
	return items, nil
}

func objectValue(value any, field string) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, &structureError{message: field + " 必须是对象"}
	}
	return object, nil
}

func optionalText(value any, present bool, field string) (string, error) {
	if !present {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", &structureError{message: field + " 缺失或类型错误"}
	}
	if textutil.Trim(text) == "" {
		return "", nil
	}
	return strValue(text, 200, field)
}

func refsValue(value any, entries []store.Entry, field string) ([]string, error) {
	items, err := arrayValue(value, 2000, field)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		id, err := strValue(item, 100, field)
		if err != nil {
			return nil, err
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil, &structureError{message: field + " 来源无效或为空"}
	}
	for _, id := range out {
		if !hasEntry(entries, id) {
			return nil, &structureError{message: field + " 来源无效或为空"}
		}
	}
	return out, nil
}

func hasEntry(entries []store.Entry, id string) bool {
	for _, entry := range entries {
		if entry.ID == id {
			return true
		}
	}
	return false
}

func entryIndex(entries []store.Entry, id string) int {
	for index, entry := range entries {
		if entry.ID == id {
			return index
		}
	}
	return len(entries)
}

func inputIndex(batch []input, id string) int {
	for index, item := range batch {
		if item.ID == id {
			return index
		}
	}
	return len(batch)
}

func inputByID(batch []input, id string) *input {
	for index := range batch {
		if batch[index].ID == id {
			return &batch[index]
		}
	}
	return nil
}

// groundQuote returns the exact original slice for a model quote. It first
// tries an exact occurrence, then whitespace-normalized and punctuation-mapped
// occurrences. accepts enforces the evidence given to aggregation stages.
func groundQuote(text, quote string, accepts func(string) bool) (string, bool) {
	if strings.Contains(text, quote) && accepts(quote) {
		return quote, true
	}
	for _, punctuation := range []bool{false, true} {
		normalizedText, starts, ends := textutil.Normalize(text, punctuation)
		needle := textutil.NormalizeString(quote, punctuation)
		if needle == "" {
			continue
		}
		haystack := []rune(normalizedText)
		pattern := []rune(needle)
		for at := runeIndex(haystack, pattern, 0); at >= 0; at = runeIndex(haystack, pattern, at+1) {
			slice := string([]rune(text)[starts[at]:ends[at+len(pattern)-1]])
			if accepts(slice) {
				return slice, true
			}
		}
	}
	return "", false
}

func runeIndex(haystack, needle []rune, from int) int {
	if len(needle) == 0 || from < 0 {
		return -1
	}
	for i := from; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func evidenceValue(value any, present bool, entries []store.Entry, field, stage string, g *generator, supplied []suppliedText) ([]Evidence, error) {
	items := []Evidence{}
	if !present {
		return items, nil
	}
	list, err := arrayValue(value, 20, field)
	if err != nil {
		return nil, err
	}
	for index, item := range list {
		path := field + "[" + itoa(index) + "]"
		object, err := objectValue(item, path)
		if err != nil {
			return nil, err
		}
		id, err := strValue(object["id"], 100, path+".id")
		if err != nil {
			return nil, err
		}
		var entry *store.Entry
		for position := range entries {
			if entries[position].ID == id {
				entry = &entries[position]
				break
			}
		}
		if entry == nil {
			return nil, &structureError{message: path + ".id 来源无效"}
		}
		quote, err := strValue(object["quote"], 2000, path+".quote")
		if err != nil {
			return nil, err
		}
		accepts := func(slice string) bool {
			if supplied == nil {
				return true
			}
			for _, item := range supplied {
				if item.ID == id && strings.Contains(item.Text, slice) {
					return true
				}
			}
			return false
		}
		grounded, ok := groundQuote(entry.Text, quote, accepts)
		if !ok {
			g.warn(stage, path+".quote", "丢弃无法落地或不在给定聚合证据内的证据")
			continue
		}
		if grounded != quote {
			g.warn(stage, path+".quote", "替换为原文精确切片")
		}
		items = append(items, Evidence{ID: id, Quote: grounded, Day: entry.Day})
	}
	if len(items) == 0 {
		g.warn(stage, field, "无可落地证据，丢弃条目")
	}
	return items, nil
}

func insightsValue(value any, entries []store.Entry, max int, field, stage string, g *generator, supplied []suppliedText) ([]Insight, error) {
	items, err := arrayValue(value, max, field)
	if err != nil {
		return nil, err
	}
	out := []Insight{}
	for index, item := range items {
		path := field + "[" + itoa(index) + "]"
		object, err := objectValue(item, path)
		if err != nil {
			return nil, err
		}
		fact, err := strValue(object["fact"], 200, path+".fact")
		if err != nil {
			return nil, err
		}
		hypothesis, err := optionalTextField(object, "hypothesis", path+".hypothesis")
		if err != nil {
			return nil, err
		}
		limitation, err := optionalTextField(object, "limitation", path+".limitation")
		if err != nil {
			return nil, err
		}
		question, err := optionalTextField(object, "question", path+".question")
		if err != nil {
			return nil, err
		}
		evidenceRaw, present := object["evidence"]
		evidence, err := evidenceValue(evidenceRaw, present, entries, path+".evidence", stage, g, supplied)
		if err != nil {
			return nil, err
		}
		if len(evidence) == 0 {
			continue
		}
		out = append(out, Insight{
			Fact: fact, Hypothesis: hypothesis, Limitation: limitation,
			Question: question, Evidence: evidence,
		})
	}
	return out, nil
}

func optionalTextField(object map[string]any, key, field string) (string, error) {
	value, present := object[key]
	return optionalText(value, present, field)
}

func questionsValue(value any, entries []store.Entry, max int, field, stage string, g *generator, supplied []suppliedText) ([]Question, error) {
	items, err := arrayValue(value, max, field)
	if err != nil {
		return nil, err
	}
	out := []Question{}
	for index, item := range items {
		path := field + "[" + itoa(index) + "]"
		object, err := objectValue(item, path)
		if err != nil {
			return nil, err
		}
		text, err := strValue(object["text"], 200, path+".text")
		if err != nil {
			return nil, err
		}
		evidenceRaw, present := object["evidence"]
		evidence, err := evidenceValue(evidenceRaw, present, entries, path+".evidence", stage, g, supplied)
		if err != nil {
			return nil, err
		}
		if len(evidence) == 0 {
			continue
		}
		out = append(out, Question{Text: text, Evidence: evidence})
	}
	return out, nil
}

func validateDaily(raw map[string]any, batchEntries []store.Entry, batch []input) (any, error) {
	sectionsRaw, err := arrayValue(raw["sections"], 2000, "sections")
	if err != nil {
		return nil, err
	}
	sections := make([]DailySection, 0, len(sectionsRaw))
	for index, item := range sectionsRaw {
		base := "sections[" + itoa(index) + "]"
		object, err := objectValue(item, base)
		if err != nil {
			return nil, err
		}
		segmentsRaw, err := arrayValue(object["segments"], 2000, base+".segments")
		if err != nil {
			return nil, err
		}
		segments := make([]DailySegment, 0, len(segmentsRaw))
		for segmentIndex, segmentItem := range segmentsRaw {
			path := base + ".segments[" + itoa(segmentIndex) + "]"
			segmentObject, err := objectValue(segmentItem, path)
			if err != nil {
				return nil, err
			}
			text, err := strValue(segmentObject["text"], 4000, path+".text")
			if err != nil {
				return nil, err
			}
			sources, err := refsValue(segmentObject["sources"], batchEntries, path+".sources")
			if err != nil {
				return nil, err
			}
			sort.SliceStable(sources, func(i, j int) bool {
				return entryIndex(batchEntries, sources[i]) < entryIndex(batchEntries, sources[j])
			})
			segments = append(segments, DailySegment{Text: text, Sources: sources})
		}
		if len(segments) == 0 {
			return nil, &structureError{message: base + ".segments 为空"}
		}
		sort.SliceStable(segments, func(i, j int) bool {
			return entryIndex(batchEntries, segments[i].Sources[0]) < entryIndex(batchEntries, segments[j].Sources[0])
		})
		sourceSet := map[string]bool{}
		sources := make([]string, 0)
		for _, segment := range segments {
			for _, id := range segment.Sources {
				if !sourceSet[id] {
					sourceSet[id] = true
					sources = append(sources, id)
				}
			}
		}
		sort.SliceStable(sources, func(i, j int) bool {
			return entryIndex(batchEntries, sources[i]) < entryIndex(batchEntries, sources[j])
		})
		bands := make([]string, 0)
		for _, id := range sources {
			item := inputByID(batch, id)
			band := "时间未记录（补录）"
			if item != nil && item.Time != nil {
				switch hour := clockHour(*item.Time); {
				case hour < 6:
					band = "凌晨"
				case hour < 12:
					band = "上午"
				case hour < 18:
					band = "下午"
				default:
					band = "晚间"
				}
			}
			found := false
			for _, existing := range bands {
				if existing == band {
					found = true
					break
				}
			}
			if !found {
				bands = append(bands, band)
			}
		}
		parts := make([]string, 0, len(bands))
		for _, band := range bands {
			if band == "时间未记录（补录）" {
				parts = append(parts, band)
			} else {
				parts = append(parts, band+"（记录时间）")
			}
		}
		sections = append(sections, DailySection{
			Period: strings.Join(parts, " / "), Segments: segments, Sources: sources,
		})
	}
	sort.SliceStable(sections, func(i, j int) bool {
		return entryIndex(batchEntries, sections[i].Sources[0]) < entryIndex(batchEntries, sections[j].Sources[0])
	})
	for _, entry := range batchEntries {
		covered := false
		for _, section := range sections {
			for _, id := range section.Sources {
				if id == entry.ID {
					covered = true
					break
				}
			}
			if covered {
				break
			}
		}
		if !covered {
			return nil, &structureError{message: "sections 未覆盖全部来源"}
		}
	}
	return dailyOutput{Sections: sections}, nil
}

func clockHour(clock string) int {
	if len(clock) < 2 {
		return 0
	}
	hour := 0
	for _, r := range clock[:2] {
		if r < '0' || r > '9' {
			return 0
		}
		hour = hour*10 + int(r-'0')
	}
	return hour
}

func validateClassification(raw map[string]any, batch []input) (any, error) {
	return validateClassificationMode(raw, batch, false)
}

// validateClassificationLenient is the one-time fallback after a repair: it only
// relaxes unknown theme names (folding them into 其他), never the structural
// requirements such as ids, points or full coverage.
func validateClassificationLenient(raw map[string]any, batch []input) (any, error) {
	return validateClassificationMode(raw, batch, true)
}

func validateClassificationMode(raw map[string]any, batch []input, lenient bool) (any, error) {
	entriesRaw, err := arrayValue(raw["entries"], len(batch), "entries")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := make([]classified, 0, len(entriesRaw))
	for index, item := range entriesRaw {
		path := "entries[" + itoa(index) + "]"
		object, err := objectValue(item, path)
		if err != nil {
			return nil, err
		}
		id, err := strValue(object["id"], 100, path+".id")
		if err != nil {
			return nil, err
		}
		var original *input
		for position := range batch {
			if batch[position].ID == id {
				original = &batch[position]
				break
			}
		}
		if original == nil || seen[id] {
			return nil, &structureError{message: path + ".id 来源无效或重复"}
		}
		seen[id] = true
		themesRaw, err := arrayValue(object["themes"], 5, path+".themes")
		if err != nil {
			return nil, err
		}
		known := make([]string, 0, len(themesRaw))
		unknown := false
		for _, themeItem := range themesRaw {
			theme, err := strValue(themeItem, 40, path+".themes")
			if err != nil {
				return nil, err
			}
			canonical, ok := canonicalTheme(theme)
			if !ok {
				if !lenient {
					return nil, &structureError{message: path + ".themes 包含不在主题表中的名称"}
				}
				unknown = true
				continue
			}
			known = append(known, canonical)
		}
		if unknown {
			known = append(known, "其他")
		}
		themes := capThemes(known, 2)
		if len(themes) == 0 {
			return nil, &structureError{message: path + ".themes 为空"}
		}
		points, err := strValue(object["points"], 1000, path+".points")
		if err != nil {
			return nil, err
		}
		out = append(out, classified{
			point:  point{ID: id, Day: original.Day, Points: points},
			Themes: themes,
		})
	}
	if len(seen) != len(batch) {
		return nil, &structureError{message: "entries 未覆盖全部记录"}
	}
	return out, nil
}

func validateReview(raw map[string]any, entries []store.Entry, minimum int, supplied []suppliedText, stage string, g *generator) (review, error) {
	size, err := jsonutil.Len(raw)
	if err != nil || size > 12000 {
		return review{}, &structureError{message: "JSON 超过12000字符"}
	}
	insights, err := insightsValue(raw["insights"], entries, 4, "insights", stage, g, supplied)
	if err != nil {
		return review{}, err
	}
	if len(insights) < minimum {
		return review{}, &structureError{message: "insights 丢弃了无法落地的证据后洞察不足"}
	}
	overview, err := strValue(raw["overview"], 1000, "overview")
	if err != nil {
		return review{}, err
	}
	changes, err := insightsValue(raw["changes"], entries, 6, "changes", stage, g, supplied)
	if err != nil {
		return review{}, err
	}
	connections, err := insightsValue(raw["connections"], entries, 6, "connections", stage, g, supplied)
	if err != nil {
		return review{}, err
	}
	questions, err := questionsValue(raw["questions"], entries, 4, "questions", stage, g, supplied)
	if err != nil {
		return review{}, err
	}
	return review{
		Overview: overview, Insights: insights, Changes: changes,
		Connections: connections, Questions: questions,
	}, nil
}

// ThemeCounts counts unique source ids per theme, not percentages.
func ThemeCounts(classifications []Classification) []Theme {
	order := make([]string, 0)
	sources := map[string][]string{}
	seen := map[string]map[string]bool{}
	for _, classification := range classifications {
		for _, theme := range classification.Themes {
			if _, ok := sources[theme]; !ok {
				order = append(order, theme)
				sources[theme] = []string{}
				seen[theme] = map[string]bool{}
			}
			if !seen[theme][classification.ID] {
				seen[theme][classification.ID] = true
				sources[theme] = append(sources[theme], classification.ID)
			}
		}
	}
	out := make([]Theme, 0, len(order))
	for _, name := range order {
		out = append(out, Theme{Name: name, Count: len(sources[name]), Sources: sources[name]})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[position:])
}
