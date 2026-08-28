package handler

import (
	"time"

	"tg_verification_go/src/model"
	"tg_verification_go/src/service"
	telegramservice "tg_verification_go/src/service/telegram"
)

type Handler struct {
	config   *model.Config
	store    *service.Store
	telegram *telegramservice.Verifier
	now      func() time.Time
}

// New creates the browser and bot API handlers.
func New(config *model.Config, stateStore *service.Store, telegramVerifier *telegramservice.Verifier) *Handler {
	return &Handler{
		config:   config,
		store:    stateStore,
		telegram: telegramVerifier,
		now:      time.Now,
	}
}
