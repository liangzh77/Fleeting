// Package scheduler performs the once-a-day automatic organization of
// yesterday's notes.
package scheduler

import (
	"sync"
	"time"

	"github.com/liangzh77/fleeting/internal/ai"
	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/store"
)

// Generator is the slice of the AI service the scheduler needs.
type Generator interface {
	Configured() bool
	Generate(kind, period, automaticDay string) error
}

// Scheduler runs one tick per minute and after startup.
type Scheduler struct {
	store   *store.Store
	ai      Generator
	now     func() time.Time
	log     func(string)
	tickMu  sync.Mutex
	mu      sync.Mutex
	started bool
	stop    chan struct{}
	done    chan struct{}
}

// New creates a scheduler using the wall clock.
func New(st *store.Store, service *ai.AI) *Scheduler {
	return &Scheduler{
		store: st,
		ai:    service,
		now:   time.Now,
		log:   func(string) {},
	}
}

// NewWithClock creates a scheduler with injectable clock and logger.
func NewWithClock(st *store.Store, service Generator, now func() time.Time, log func(string)) *Scheduler {
	if now == nil {
		now = time.Now
	}
	if log == nil {
		log = func(string) {}
	}
	return &Scheduler{store: st, ai: service, now: now, log: log}
}

// Tick checks and runs the automatic job once. It is safe to call concurrently.
func (s *Scheduler) Tick() error {
	s.tickMu.Lock()
	defer s.tickMu.Unlock()
	now := s.now()
	local := now.In(s.store.Location())
	if local.Hour() < 1 || !s.ai.Configured() {
		return nil
	}
	day := local.Format("2006-01-02")
	period := config.Yesterday(day)
	attempted, err := s.store.MetaHas("auto-day:" + day)
	if err != nil {
		return err
	}
	if attempted {
		return nil
	}
	entries, err := s.store.Entries(period, "day")
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	ready, err := s.store.LatestReady("day", period)
	if err != nil {
		return err
	}
	if ready != nil && ready.Fingerprint == s.store.Snapshot(entries) {
		return nil
	}
	job, err := s.store.LatestJob("day", period)
	if err != nil {
		return err
	}
	if job != nil && job.State == "running" {
		return nil
	}
	if err := s.ai.Generate("day", period, day); err != nil {
		s.log("自动整理未完成；原文和旧结果保留，可手动重试")
	}
	return nil
}

// Start launches the immediate tick and a one-minute loop.
func (s *Scheduler) Start() {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.stop = make(chan struct{})
	s.done = make(chan struct{})
	s.mu.Unlock()

	go func() {
		defer close(s.done)
		_ = s.Tick()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = s.Tick()
			case <-s.stop:
				return
			}
		}
	}()
}

// Stop stops the loop. It is idempotent.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	if !s.started {
		s.mu.Unlock()
		return
	}
	s.started = false
	close(s.stop)
	done := s.done
	s.mu.Unlock()
	<-done
}
