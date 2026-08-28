package service

import (
	"context"
	"crypto/subtle"
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

type sessionState struct {
	session      model.Session
	stage        verificationStage
	antiBotToken string
	nonce        string
	powToken     string
	challenge    string
	user         model.TelegramUser
}

type Store struct {
	mu                sync.Mutex
	ttl               time.Duration
	verifiedRetention time.Duration
	sessions          map[string]sessionState
}

// NewStore creates an empty in-memory verification state store.
func NewStore(ttl, verifiedRetention time.Duration) *Store {
	return &Store{
		ttl:               ttl,
		verifiedRetention: verifiedRetention,
		sessions:          make(map[string]sessionState),
	}
}

// TTL returns the configured session lifetime.
func (s *Store) TTL() time.Duration {
	return s.ttl
}

// PutSession stores a new session unless its ID already exists.
func (s *Store) PutSession(session model.Session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.sessions[session.ID]; exists {
		return false
	}
	s.sessions[session.ID] = sessionState{session: session, stage: stageCreated}
	return true
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

// PassTurnstile atomically records anti-bot proof and returns the credentials
// for the Telegram stage. Repeated proofs at the same stage return the original
// credentials instead of resetting the session.
func (s *Store) PassTurnstile(sessionID, antiBotToken, nonce string, now time.Time) (string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, exists := s.sessions[sessionID]
	if !exists || state.session.EffectiveStatus(now) != model.SessionStatusPending {
		return "", "", false
	}
	switch state.stage {
	case stageAntiBotPassed:
		return state.antiBotToken, state.nonce, true
	case stageCreated:
		state.stage = stageAntiBotPassed
		state.antiBotToken = antiBotToken
		state.nonce = nonce
		s.sessions[sessionID] = state
		return antiBotToken, nonce, true
	default:
		return "", "", false
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
				for id, state := range s.sessions {
					removeAt := state.session.ExpiresAt.Add(s.verifiedRetention)
					if state.stage == stageVerified {
						removeAt = state.session.VerifiedAt.Add(s.verifiedRetention)
					}
					if !now.Before(removeAt) {
						delete(s.sessions, id)
					}
				}
				s.mu.Unlock()
			}
		}
	}()
}

func equalToken(expected, actual string) bool {
	return expected != "" && actual != "" && subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}
