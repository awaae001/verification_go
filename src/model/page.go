package model

import "html/template"

// Page states rendered by the verification page template. They are untyped
// string constants so templates can compare them directly.
const (
	PageStateActive   = "active"
	PageStateExpired  = "expired"
	PageStateNotFound = "notfound"
	PageStateDone     = "done"
)

type PageView struct {
	State        string
	Lang         string
	AssetVersion string
	Config       template.JS
}

type PageConfig struct {
	SessionID        string            `json:"session_id"`
	TurnstileSiteKey string            `json:"turnstile_site_key"`
	TurnstileAction  string            `json:"turnstile_action"`
	TelegramClientID string            `json:"telegram_client_id"`
	ExpiresAt        int64             `json:"expires_at"`
	Lang             string            `json:"lang"`
	Messages         map[string]string `json:"messages"`
}
