package cmd

import (
	"fmt"

	"tg_verification_go/src/config"
)

// Run loads the configuration and starts the HTTP server. It blocks until
// the server exits.
func Run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	addr := fmt.Sprintf("%s:%s", cfg.ListenAddress, cfg.Port)
	if err := newRouter().Run(addr); err != nil {
		return fmt.Errorf("[cmd][http] server exited: %w", err)
	}
	return nil
}
