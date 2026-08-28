package handler

import (
	"log"
	"net/http"

	"tg_verification_go/src/model/dto"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

// VerifyTelegram validates Telegram OIDC and issues a one-time PoW token.
func (h *Handler) VerifyTelegram(c *gin.Context) {
	sessionID := c.Param("sid")
	var request dto.VerifyTelegramRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		utils.AbortWithError(c, utils.WrapError(utils.CodeInvalidRequest, "invalid request", err))
		return
	}
	now := h.now()
	user, err := h.telegram.Verify(c.Request.Context(), request.IDToken, request.Nonce, now)
	if err != nil {
		log.Printf("[handle][telegram] ID token rejected: %v", err)
		utils.AbortWithError(c, err)
		return
	}
	powToken, err := utils.NewSecureToken()
	if err != nil {
		log.Printf("[handle][telegram] failed to generate PoW token: %v", err)
		utils.AbortWithError(c, utils.WrapError(utils.CodeInternal, "failed to create PoW token", err))
		return
	}
	if !h.store.CompleteTelegram(sessionID, request.Nonce, powToken, user, now) {
		utils.AbortWithError(c, utils.NewError(utils.CodeStateConflict, "nonce is missing, expired, or already consumed"))
		return
	}
	c.JSON(http.StatusOK, dto.VerifyTelegramResponse{PoWToken: powToken})
}
