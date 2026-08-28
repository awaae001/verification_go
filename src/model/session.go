package model

import "time"

type SessionStatus string

const (
	SessionStatusPending  SessionStatus = "pending"
	SessionStatusVerified SessionStatus = "verified"
	SessionStatusExpired  SessionStatus = "expired"
)

type Session struct {
	ID         string
	Client     string
	Status     SessionStatus
	User       TelegramUser
	CreatedAt  time.Time
	ExpiresAt  time.Time
	VerifiedAt time.Time
}

// EffectiveStatus maps overdue pending sessions to expired.
func (s Session) EffectiveStatus(now time.Time) SessionStatus {
	if s.Status == SessionStatusPending && !now.Before(s.ExpiresAt) {
		return SessionStatusExpired
	}
	return s.Status
}
