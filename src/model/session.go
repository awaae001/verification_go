package model

import "time"

type SessionStatus string

const (
	SessionStatusPending  SessionStatus = "pending"
	SessionStatusVerified SessionStatus = "verified"
	SessionStatusExpired  SessionStatus = "expired"
)

type TelegramUser struct {
	ID   int64
	Name string
}

type Session struct {
	ID         string
	Status     SessionStatus
	User       TelegramUser
	CreatedAt  time.Time
	ExpiresAt  time.Time
	VerifiedAt time.Time
}

// EffectiveStatus maps overdue pending sessions to expired. Verified sessions
// never report expired: the bot may poll the result after ephemeral states
// have been swept.
func (s *Session) EffectiveStatus(now time.Time) SessionStatus {
	if s.Status == SessionStatusPending && now.After(s.ExpiresAt) {
		return SessionStatusExpired
	}
	return s.Status
}
