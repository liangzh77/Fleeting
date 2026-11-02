package ai

import "github.com/liangzh77/fleeting/internal/store"

// daily organizes one day in batches. A truncated model answer splits the batch
// and reruns both stages, so no source text is dropped.
func (g *generator) daily() ([]DailySection, error) {
	sections := []DailySection{}
	for index := 0; index < len(g.chunks); index++ {
		batch := g.chunks[index]
		batchEntries := entriesForBatch(g.entries, batch)
		validate := func(raw map[string]any) (any, error) {
			return validateDaily(raw, batchEntries, batch)
		}
		firstAny, err := g.structured("日整理第一阶段", dailyInstruction, batch, validate)
		if err != nil {
			if isTruncated(err) {
				parts, splitErr := splitBatch(batch)
				if splitErr != nil {
					return nil, splitErr
				}
				g.chunks = insertChunks(g.chunks, index, parts)
				continue
			}
			return nil, err
		}
		first := firstAny.(dailyOutput)
		checkedAny, err := g.structured(
			"日整理核对阶段",
			dailyInstruction+dailyCheckSuffix,
			map[string]any{"originals": batch, "candidate": first},
			validate,
		)
		if err != nil {
			if isTruncated(err) {
				parts, splitErr := splitBatch(batch)
				if splitErr != nil {
					return nil, splitErr
				}
				g.chunks = insertChunks(g.chunks, index, parts)
				continue
			}
			return nil, err
		}
		checked := checkedAny.(dailyOutput)
		sections = append(sections, checked.Sections...)
	}
	return sections, nil
}

func entriesForBatch(entries []store.Entry, batch []input) []store.Entry {
	wanted := map[string]bool{}
	for _, item := range batch {
		wanted[item.ID] = true
	}
	out := make([]store.Entry, 0, len(wanted))
	for _, entry := range entries {
		if wanted[entry.ID] {
			out = append(out, entry)
		}
	}
	return out
}
