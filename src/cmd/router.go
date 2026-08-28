package cmd

import (
	"fmt"

	"tg_verification_go/src/handler"
	"tg_verification_go/src/middleware"
	"tg_verification_go/src/model"
	"tg_verification_go/src/page"
	"tg_verification_go/src/service"
	telegramservice "tg_verification_go/src/service/telegram"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

// newRouter builds the HTTP engine and registers the full route table.
func newRouter(config *model.Config, stateStore *service.Store) *gin.Engine {
	router := gin.New()
	router.Use(
		gin.Logger(),
		middleware.ErrorHandler(),
		gin.CustomRecovery(func(c *gin.Context, recovered any) {
			utils.AbortWithError(c, fmt.Errorf("panic: %v", recovered))
		}),
	)

	telegramVerifier := telegramservice.NewVerifier(config.Telegram.ClientID)
	verificationHandler := handler.New(config, stateStore, telegramVerifier)
	turnstileHandler := service.NewTurnstileHandler(
		stateStore,
		config.Turnstile.Secret,
		config.Turnstile.Action,
	)
	clientAuth := middleware.ClientAuth(config)
	antiBot := middleware.NewAntiBot(stateStore)
	pageRenderer := page.NewRenderer(config, stateStore)

	// The verification page and its assets are intentionally public: they are
	// read-only and expose only the site key, client ID, and session ID.
	router.GET("/v/:sid", pageRenderer.Verification)
	router.GET("/privacy", pageRenderer.Privacy)
	router.GET("/static/*filepath", pageRenderer.Static())

	apiGroup := router.Group("/api")
	{
		sessionsGroup := apiGroup.Group("/sessions")
		{
			sessionsGroup.POST("", clientAuth, verificationHandler.CreateSession)
			sessionsGroup.GET("/:sid/status", clientAuth, verificationHandler.SessionStatus)

			sessionsGroup.POST("/:sid/antibot", turnstileHandler.Verify)
			sessionsGroup.POST("/:sid/telegram", antiBot.Protect, verificationHandler.VerifyTelegram)
			sessionsGroup.POST("/:sid/challenge", antiBot.Protect, verificationHandler.CreateChallenge)
			sessionsGroup.POST("/:sid/pow", antiBot.Protect, verificationHandler.VerifyPoW)
		}
	}

	return router
}
