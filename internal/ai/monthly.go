package ai

import "github.com/liangzh77/fleeting/internal/store"

// completedBatch carries a successfully classified batch and its information
// points into the leaf review stage.
type completedBatch struct {
	batch  []input
	points []point
}

// monthly classifies everything, reviews each leaf, then aggregates reviews
// with only their exact evidence, never an unbounded copy of all originals.
func (g *generator) monthly() (Monthly, error) {
	classifications := []Classification{}
	completed := []completedBatch{}
	for index := 0; index < len(g.chunks); index++ {
		batch := g.chunks[index]
		validate := func(raw map[string]any) (any, error) {
			return validateClassification(raw, batch)
		}
		classifiedAny, err := g.structured("月度分类", classificationInstruction, batch, validate)
		if err != nil {
			if isTruncated(err) {
				parts, splitErr := splitBatch(batch)
				if splitErr != nil {
					return Monthly{}, splitErr
				}
				g.chunks = insertChunks(g.chunks, index, parts)
				continue
			}
			return Monthly{}, err
		}
		classifiedItems := classifiedAny.([]classified)
		for _, item := range classifiedItems {
			merged := false
			for position := range classifications {
				if classifications[position].ID == item.ID {
					classifications[position].Themes = mergeStrings(classifications[position].Themes, item.Themes)
					merged = true
					break
				}
			}
			if !merged {
				classifications = append(classifications, Classification{ID: item.ID, Themes: item.Themes})
			}
		}
		points := make([]point, 0, len(classifiedItems))
		for _, item := range classifiedItems {
			points = append(points, item.point)
		}
		completed = append(completed, completedBatch{batch: batch, points: points})
	}

	onlyCompleted := len(completed) == 1
	reviews := []review{}
	for _, item := range completed {
		part, err := g.leaves(item.batch, item.points, onlyCompleted)
		if err != nil {
			return Monthly{}, err
		}
		reviews = append(reviews, part...)
	}
	for len(reviews) > 1 {
		next := []review{}
		for index := 0; index < len(reviews); index += 2 {
			if index+1 >= len(reviews) {
				next = append(next, reviews[index])
				continue
			}
			pair := []review{reviews[index], reviews[index+1]}
			quotes := collectEvidence(pair)
			originals := make([]suppliedText, 0, len(quotes))
			for _, quote := range quotes {
				originals = append(originals, suppliedText{ID: quote.ID, Day: quote.Day, Text: quote.Quote})
			}
			minimum := 0
			if len(reviews) == 2 && len(g.entries) >= 2 {
				minimum = 1
			}
			merged, err := g.review(
				"月度层级聚合",
				reviewInstruction+aggregateSuffix,
				map[string]any{"reviews": pair, "originals": originals},
				originals,
				minimum,
			)
			if err != nil {
				if !isTruncated(err) {
					return Monthly{}, err
				}
				compact := []review{}
				for _, item := range pair {
					compressed, err := g.review(
						"月度压缩回顾",
						reviewInstruction+compressReviewSuffix,
						map[string]any{"reviews": []review{item}, "originals": originals},
						originals,
						0,
					)
					if err != nil {
						return Monthly{}, err
					}
					compact = append(compact, compressed)
				}
				merged, err = g.review(
					"月度压缩聚合",
					reviewInstruction+compressAggregateSuffix,
					map[string]any{"reviews": compact, "originals": originals},
					originals,
					minimum,
				)
				if err != nil {
					return Monthly{}, err
				}
			}
			next = append(next, merged)
		}
		reviews = next
	}
	raw := reviews[0]
	if len(g.entries) >= 2 && len(raw.Insights) == 0 {
		return Monthly{}, &structureError{message: "月度最终回顾结构校验失败：insights 丢弃了无法落地的证据后洞察不足"}
	}
	return Monthly{
		Overview:        raw.Overview,
		Classifications: classifications,
		Themes:          ThemeCounts(classifications),
		Total:           len(g.entries),
		ActiveDays:      activeDays(g.entries),
		Insights:        raw.Insights,
		Changes:         raw.Changes,
		Connections:     raw.Connections,
		Questions:       raw.Questions,
	}, nil
}

// leaves reviews one classified batch. Truncation splits the batch and reviews
// each part separately; points are filtered to the part's ids.
func (g *generator) leaves(batch []input, points []point, onlyCompleted bool) ([]review, error) {
	filtered := make([]point, 0, len(points))
	for _, item := range points {
		if inputIndex(batch, item.ID) < len(batch) {
			filtered = append(filtered, item)
		}
	}
	data := map[string]any{"originals": batch, "points": filtered}
	minimum := 0
	if onlyCompleted && len(g.entries) >= 2 && distinctIDs(batch) == len(g.entries) {
		minimum = 1
	}
	result, err := g.review("月度叶回顾", reviewInstruction, data, nil, minimum)
	if err != nil {
		if !isTruncated(err) {
			return nil, err
		}
		parts, splitErr := splitBatch(batch)
		if splitErr != nil {
			return nil, splitErr
		}
		out := []review{}
		for _, part := range parts {
			items, err := g.leaves(part, points, onlyCompleted)
			if err != nil {
				return nil, err
			}
			out = append(out, items...)
		}
		return out, nil
	}
	return []review{result}, nil
}

func (g *generator) review(stage, instruction string, data any, supplied []suppliedText, minimum int) (review, error) {
	result, err := g.structured(stage, instruction, data, func(raw map[string]any) (any, error) {
		return validateReview(raw, g.entries, minimum, supplied, stage, g)
	})
	if err != nil {
		return review{}, err
	}
	return result.(review), nil
}

func collectEvidence(reviews []review) []Evidence {
	out := []Evidence{}
	for _, item := range reviews {
		for _, group := range [][]Insight{item.Insights, item.Changes, item.Connections} {
			for _, insight := range group {
				out = append(out, insight.Evidence...)
			}
		}
		for _, question := range item.Questions {
			out = append(out, question.Evidence...)
		}
	}
	return out
}

func mergeStrings(existing, extra []string) []string {
	seen := map[string]bool{}
	for _, value := range existing {
		seen[value] = true
	}
	for _, value := range extra {
		if !seen[value] {
			seen[value] = true
			existing = append(existing, value)
		}
	}
	return existing
}

func distinctIDs(batch []input) int {
	seen := map[string]bool{}
	for _, item := range batch {
		seen[item.ID] = true
	}
	return len(seen)
}

func activeDays(entries []store.Entry) int {
	seen := map[string]bool{}
	for _, entry := range entries {
		seen[entry.Day] = true
	}
	return len(seen)
}
