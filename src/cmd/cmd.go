package cmd

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"tg_verification_go/src/config"
	"tg_verification_go/src/service"
)

// Run loads configuration, starts the HTTP server, and blocks until shutdown.
func Run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("[cmd][start] load config: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	stateStore := service.NewStore(
		time.Duration(cfg.State.TTLSeconds)*time.Second,
		time.Duration(cfg.State.VerifiedRetentionSeconds)*time.Second,
	)
	stateStore.StartJanitor(ctx, time.Minute)

	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%s", cfg.ListenAddress, cfg.Port),
		Handler:           newRouter(cfg, stateStore),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("[cmd][http] listening on %s", server.Addr)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("[cmd][http] serve: %w", err)
		}
		return nil
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("[cmd][http] shutdown: %w", err)
	}
	return nil
}
