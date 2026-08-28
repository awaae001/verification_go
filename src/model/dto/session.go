package dto

import "tg_verification_go/src/model"

type CreateSessionResponse struct {
	SessionID string `json:"session_id"`
	VerifyURL string `json:"verify_url"`
	ExpiresAt int64  `json:"expires_at"`
}

type SessionStatusResponse struct {
	SessionID string              `json:"session_id"`
	Status    model.SessionStatus `json:"status"`
	UserID    int64               `json:"user_id,omitempty"`
	UserName  string              `json:"user_name,omitempty"`
}
