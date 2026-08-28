package config

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"tg_verification_go/src/model"

	"github.com/spf13/viper"
)

//go:embed defaults/*.json
var defaultConfigFiles embed.FS

var (
	currentConfig atomic.Pointer[model.Config]
	loadErr       error
	once          sync.Once
)

// Load initializes the global configuration snapshot once.
//
// It releases missing default JSON files, reads .env and JSON config files,
// applies environment overrides, and publishes the resulting immutable
// snapshot for GetConfig. Persisted config changes only take effect after a process restart.
func Load() (*model.Config, error) {
	once.Do(func() {
		var cfg *model.Config
		cfg, loadErr = loadConfig()
		if loadErr == nil {
			currentConfig.Store(cfg)
		}
	})
	return currentConfig.Load(), loadErr
}

// GetConfig returns the currently published configuration snapshot.
//
// Callers must treat the returned Config as read-only: the snapshot never changes after Load.
func GetConfig() *model.Config {
	cfg := currentConfig.Load()
	if cfg == nil {
		log.Fatal("config not initialized, call Load() first")
	}
	return cfg
}

func loadConfig() (*model.Config, error) {
	v := newConfigReader()
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); ok || errors.Is(err, os.ErrNotExist) {
			log.Printf(".env file not found, skipping")
		} else {
			return nil, fmt.Errorf("failed to parse .env file: %w", err)
		}
	}

	configPath := v.GetString("CONFIG_PATH")
	if configPath == "" {
		configPath = "data"
	}
	if err := os.MkdirAll(configPath, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create config directory: %w", err)
	}
	defaultContent, err := fs.ReadFile(defaultConfigFiles, "defaults/system_config.json")
	if err != nil {
		return nil, fmt.Errorf("failed to read embedded default config: %w", err)
	}
	defaultPath := filepath.Join(configPath, "system_config.json")
	file, err := os.OpenFile(defaultPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	switch {
	case errors.Is(err, os.ErrExist):
		// User config already exists, keep it.
	case err != nil:
		return nil, fmt.Errorf("failed to create default config %s: %w", defaultPath, err)
	default:
		if _, err := file.Write(defaultContent); err != nil {
			_ = file.Close()
			_ = os.Remove(defaultPath)
			return nil, fmt.Errorf("failed to write default config %s: %w", defaultPath, err)
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(defaultPath)
			return nil, fmt.Errorf("failed to close default config %s: %w", defaultPath, err)
		}
		log.Printf("[config] released default config: %s", defaultPath)
	}

	// A missing file is fine: environment variables and built-in defaults
	// still apply.
	v.SetConfigName("system_config")
	v.SetConfigType("json")
	v.AddConfigPath(configPath)
	if err := v.MergeInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); ok {
			log.Printf("config file (%s/system_config.json) not found, skipping merge", configPath)
		} else {
			return nil, fmt.Errorf("failed to merge system_config.json: %w", err)
		}
	}

	cfg := &model.Config{}
	if err := unmarshalConfig(v, cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config into struct: %w", err)
	}

	return cfg, nil
}

func newConfigReader() *viper.Viper {
	v := viper.New()
	v.SetConfigFile(".env")
	v.SetConfigType("env")
	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	return v
}

// unmarshalConfig resolves environment overrides and the system_conf section
// into the Config struct, applying defaults for zero values.
func unmarshalConfig(v *viper.Viper, cfg *model.Config) error {
	cfg.Port = v.GetString("PORT")
	cfg.ListenAddress = v.GetString("LISTEN_ADDRESS")
	cfg.ConfigPath = v.GetString("CONFIG_PATH")
	cfg.IsDev = parseEnvBool(v.GetString("IS_DEV"))

	if cfg.Port == "" {
		cfg.Port = "8080"
	}
	if cfg.ListenAddress == "" {
		cfg.ListenAddress = "0.0.0.0"
	}
	if cfg.ConfigPath == "" {
		cfg.ConfigPath = "data"
	}

	if err := v.UnmarshalKey("system_conf", cfg); err != nil {
		return fmt.Errorf("failed to unmarshal system config: %w", err)
	}

	// Secrets and deploy-specific values may be overridden by environment.
	if siteKey := v.GetString("TURNSTILE_SITE_KEY"); siteKey != "" {
		cfg.Turnstile.SiteKey = siteKey
	}
	if turnstileSecret := v.GetString("TURNSTILE_SECRET"); turnstileSecret != "" {
		cfg.Turnstile.Secret = turnstileSecret
	}
	if telegramClientID := v.GetString("TELEGRAM_CLIENT_ID"); telegramClientID != "" {
		cfg.Telegram.ClientID = telegramClientID
	}
	if keys := v.GetString("TRUSTED_CLIENT_KEYS"); keys != "" {
		cfg.TrustedClientKeys = map[string]string{}
		for _, pair := range strings.Split(keys, ",") {
			name, key, ok := strings.Cut(pair, "=")
			if name = strings.TrimSpace(name); !ok || name == "" || key == "" {
				continue
			}
			cfg.TrustedClientKeys[name] = key
		}
	}

	if cfg.PoW.Difficulty <= 0 {
		cfg.PoW.Difficulty = 6
	}
	if cfg.PoW.MaximumWork <= 0 {
		cfg.PoW.MaximumWork = 268435456
	}
	if cfg.State.TTLSeconds <= 0 {
		cfg.State.TTLSeconds = 600
	}

	return nil
}

func parseEnvBool(val string) bool {
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}
