package service

import (
	"context"
	"crypto/subtle"
	"errors"
	"sync"
	"time"

	"tg_verification_go/src/model"
)

type verificationStage uint8

const (
	stageCreated verificationStage = iota
	stageAntiBotPassed
	stageTelegramPassed
	stageChallengeIssued
	stageVerified
)

type turnstileStartResult uint8

const (
	turnstileStarted turnstileStartResult = iota
	turnstileSessionInactive
	turnstileStageConflict
	turnstileAttemptInFlight
	turnstileRetryTooSoon
	turnstileAttemptsExhausted
)

type sessionState struct {
	session              model.Session
	stage                verificationStage
	antiBotToken         string
	nonce                string
	powToken             string
	challenge            string
	user                 model.TelegramUser
	turnstileInFlight    bool
	turnstileAttempts    int
	turnstileLastAttempt time.Time
}

var (
	// ErrSessionExists indicates that a session ID is already stored.
	ErrSessionExists = errors.New("session already exists")
	// ErrSessionCapacity indicates that the global session limit was reached.
	ErrSessionCapacity = errors.New("session capacity reached")
	// ErrClientSessionCapacity indicates that a client's session limit was reached.
	ErrClientSessionCapacity = errors.New("client session capacity reached")
)

type Store struct {
	mu                   sync.Mutex
	ttl                  time.Duration
	verifiedRetention    time.Duration
	maxSessions          int
	maxSessionsPerClient int
	sessions             map[string]sessionState
	clientSessions       map[string]int
}

type StoreConfig struct {
	TTL                  time.Duration
	VerifiedRetention    time.Duration
	MaxSessions          int
	MaxSessionsPerClient int
}

// NewStore creates an empty in-memory verification state store.
func NewStore(config StoreConfig) *Store {
	return &Store{
		ttl:                  config.TTL,
		verifiedRetention:    config.VerifiedRetention,
		maxSessions:          config.MaxSessions,
		maxSessionsPerClient: config.MaxSessionsPerClient,
		sessions:             make(map[string]sessionState),
		clientSessions:       make(map[string]int),
	}
}

// TTL returns the configured session lifetime.
func (s *Store) TTL() time.Duration {
	return s.ttl
}

// PutSession stores a new session and reports ID collisions or capacity limits.
func (s *Store) PutSession(session model.Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeExpiredLocked(session.CreatedAt)
	if _, exists := s.sessions[session.ID]; exists {
		return ErrSessionExists
	}
	if len(s.sessions) >= s.maxSessions {
		return ErrSessionCapacity
	}
	if s.clientSessions[session.Client] >= s.maxSessionsPerClient {
		return ErrClientSessionCapacity
	}
	s.sessions[session.ID] = sessionState{session: session, stage: stageCreated}
	s.clientSessions[session.Client]++
	return nil
}

// GetSession returns a copy of a session with its effective status.
func (s *Store) GetSession(id string, now time.Time) (model.Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[id]
	if !exists {
		return model.Session{}, false
	}
	session := state.session
	session.Status = session.EffectiveStatus(now)
	return session, true
}

// IsSessionActive reports whether a pending session has not expired.
func (s *Store) IsSessionActive(id string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[id]
	return exists && state.session.EffectiveStatus(now) == model.SessionStatusPending
}

func (s *Store) beginTurnstile(sessionID string, now time.Time, maxAttempts int, retryInterval time.Duration) turnstileStartResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || state.session.EffectiveStatus(now) != model.SessionStatusPending {
		return turnstileSessionInactive
	}
	if state.stage != stageCreated {
		return turnstileStageConflict
	}
	if state.turnstileInFlight {
		return turnstileAttemptInFlight
	}
	if state.turnstileAttempts >= maxAttempts {
		return turnstileAttemptsExhausted
	}
	if !state.turnstileLastAttempt.IsZero() && now.Sub(state.turnstileLastAttempt) < retryInterval {
		return turnstileRetryTooSoon
	}
	state.turnstileInFlight = true
	s.sessions[sessionID] = state
	return turnstileStarted
}

func (s *Store) recordTurnstileAttempt(sessionID string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || !state.turnstileInFlight {
		return
	}
	state.turnstileAttempts++
	state.turnstileLastAttempt = now
	s.sessions[sessionID] = state
}

func (s *Store) finishTurnstileAttempt(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists {
		return
	}
	state.turnstileInFlight = false
	s.sessions[sessionID] = state
}

// PassTurnstile atomically records anti-bot proof and returns the credentials and session expiration for the Telegram stage.
func (s *Store) PassTurnstile(sessionID, antiBotToken, nonce string, now time.Time) (string, string, time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || state.session.EffectiveStatus(now) != model.SessionStatusPending {
		return "", "", time.Time{}, false
	}
	switch state.stage {
	case stageCreated:
		state.stage = stageAntiBotPassed
		state.antiBotToken = antiBotToken
		state.nonce = nonce
		state.turnstileInFlight = false
		s.sessions[sessionID] = state
		return antiBotToken, nonce, state.session.ExpiresAt, true
	default:
		return "", "", time.Time{}, false
	}
}

// CheckAntiBot validates the reusable anti-bot token for the current session stage.
func (s *Store) CheckAntiBot(token, sessionID string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || state.session.EffectiveStatus(now) != model.SessionStatusPending {
		return false
	}
	if state.stage < stageAntiBotPassed || state.stage > stageChallengeIssued {
		return false
	}
	return equalToken(state.antiBotToken, token)
}

// CompleteTelegram atomically consumes the nonce and records Telegram identity.
func (s *Store) CompleteTelegram(sessionID, nonce, powToken string, user model.TelegramUser, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || state.session.EffectiveStatus(now) != model.SessionStatusPending {
		return false
	}
	if state.stage != stageAntiBotPassed || !equalToken(state.nonce, nonce) {
		return false
	}
	state.stage = stageTelegramPassed
	state.nonce = ""
	state.powToken = powToken
	state.user = user
	s.sessions[sessionID] = state
	return true
}

// IssueChallenge atomically consumes the PoW token and records its challenge.
func (s *Store) IssueChallenge(sessionID, powToken, challenge string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || state.session.EffectiveStatus(now) != model.SessionStatusPending {
		return false
	}
	if state.stage != stageTelegramPassed || !equalToken(state.powToken, powToken) {
		return false
	}
	state.stage = stageChallengeIssued
	state.powToken = ""
	state.challenge = challenge
	s.sessions[sessionID] = state
	return true
}

// HasChallenge reports whether challenge is the active challenge for a session.
func (s *Store) HasChallenge(sessionID, challenge string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	return exists &&
		state.session.EffectiveStatus(now) == model.SessionStatusPending &&
		state.stage == stageChallengeIssued &&
		equalToken(state.challenge, challenge)
}

// CompleteChallenge atomically consumes a challenge and verifies its session.
func (s *Store) CompleteChallenge(sessionID, challenge string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || state.session.EffectiveStatus(now) != model.SessionStatusPending {
		return false
	}
	if state.stage != stageChallengeIssued || !equalToken(state.challenge, challenge) {
		return false
	}
	state.stage = stageVerified
	state.challenge = ""
	state.antiBotToken = ""
	state.session.Status = model.SessionStatusVerified
	state.session.User = state.user
	state.session.VerifiedAt = now
	s.sessions[sessionID] = state
	return true
}

// StartJanitor removes expired sessions until ctx is canceled.
func (s *Store) StartJanitor(ctx context.Context, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				s.mu.Lock()
				s.removeExpiredLocked(now)
				s.mu.Unlock()
			}
		}
	}()
}

func (s *Store) removeExpiredLocked(now time.Time) {
	for id, state := range s.sessions {
		removeAt := state.session.ExpiresAt
		if state.stage == stageVerified {
			removeAt = state.session.VerifiedAt.Add(s.verifiedRetention)
		}
		if !now.Before(removeAt) {
			delete(s.sessions, id)
			s.clientSessions[state.session.Client]--
			if s.clientSessions[state.session.Client] == 0 {
				delete(s.clientSessions, state.session.Client)
			}
		}
	}
}

func equalToken(expected, actual string) bool {
	return expected != "" && actual != "" && subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}
