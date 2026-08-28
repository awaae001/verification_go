package model

import "crypto/subtle"

// Config is the root configuration snapshot of the verification service.
//
// Fields without a mapstructure tag are populated from environment variables
// only. The nested sections are unmarshaled from the system_conf key of
// system_config.json. Callers must treat a published Config as read-only.
type Config struct {
	// Environment-level settings.
	ListenAddress string
	Port          string
	ConfigPath    string
	IsDev         bool

	// System configuration loaded from system_config.json.
	Turnstile         TurnstileConfig   `mapstructure:"turnstile_conf"`
	Telegram          TelegramConfig    `mapstructure:"telegram_conf"`
	PoW               PoWConfig         `mapstructure:"pow_conf"`
	State             StateConfig       `mapstructure:"state_conf"`
	TrustedClientKeys map[string]string `mapstructure:"trusted_client_keys"`
}

// IsTrustedClient reports whether key matches any configured trusted client
// key, returning the matching client name. Comparison runs in constant time
// to avoid leaking keys through timing.
func (c *Config) IsTrustedClient(key string) (string, bool) {
	if key == "" {
		return "", false
	}
	for name, k := range c.TrustedClientKeys {
		if subtle.ConstantTimeCompare([]byte(k), []byte(key)) == 1 {
			return name, true
		}
	}
	return "", false
}

// TurnstileConfig holds Cloudflare Turnstile settings.
type TurnstileConfig struct {
	SiteKey string `mapstructure:"site_key"`
	Secret  string `mapstructure:"secret"`
	Action  string `mapstructure:"action"`
}

// TelegramConfig holds Telegram Login OIDC settings.
type TelegramConfig struct {
	ClientID string `mapstructure:"client_id"`
}

// PoWConfig holds proof-of-work challenge parameters.
type PoWConfig struct {
	Difficulty  int   `mapstructure:"difficulty"`
	MaximumWork int64 `mapstructure:"maximum_work"`
}

// StateConfig holds ephemeral verification state settings.
type StateConfig struct {
	TTLSeconds int `mapstructure:"ttl_seconds"`
}
