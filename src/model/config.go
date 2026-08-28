package model

import (
	"crypto/sha256"
	"crypto/subtle"
)

// MaxPoWDifficulty is the maximum meaningful PoW difficulty: the number of hex
// digits in a SHA-256 digest.
const MaxPoWDifficulty = sha256.Size * 2

// Config is the immutable root configuration snapshot.
type Config struct {
	ListenAddress string
	Port          string
	ConfigPath    string
	PublicBaseURL string `mapstructure:"base_url"`
	IsDev         bool

	Turnstile         TurnstileConfig   `mapstructure:"turnstile_conf"`
	Telegram          TelegramConfig    `mapstructure:"telegram_conf"`
	PoW               PoWConfig         `mapstructure:"pow_conf"`
	State             StateConfig       `mapstructure:"state_conf"`
	TrustedClientKeys map[string]string `mapstructure:"trusted_client_keys"`
}

// IsTrustedClient reports whether key matches a configured client key.
func (c *Config) IsTrustedClient(key string) (string, bool) {
	for name, configuredKey := range c.TrustedClientKeys {
		if subtle.ConstantTimeCompare([]byte(configuredKey), []byte(key)) == 1 {
			return name, true
		}
	}
	return "", false
}

type TurnstileConfig struct {
	SiteKey string `mapstructure:"site_key"`
	Secret  string `mapstructure:"secret"`
	Action  string `mapstructure:"action"`
}

type TelegramConfig struct {
	ClientID string `mapstructure:"client_id"`
}

type PoWConfig struct {
	Difficulty  int   `mapstructure:"difficulty"`
	MaximumWork int64 `mapstructure:"maximum_work"`
}

type StateConfig struct {
	TTLSeconds               int `mapstructure:"ttl_seconds"`
	VerifiedRetentionSeconds int `mapstructure:"verified_retention_seconds"`
}
