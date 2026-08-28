package handler

import (
	"net/http"

	"tg_verification_go/src/middleware"
	"tg_verification_go/src/model"
	"tg_verification_go/src/model/dto"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

// SessionStatus returns the current result for a client-owned session.
func (h *Handler) SessionStatus(c *gin.Context) {
	session, exists := h.store.GetSession(c.Param("sid"), h.now())
	if !exists || session.Client != middleware.ClientName(c) {
		utils.AbortWithError(c, utils.NewError(utils.CodeSessionNotFound, "session not found"))
		return
	}
	response := dto.SessionStatusResponse{
		SessionID: session.ID,
		Status:    session.Status,
	}
	if session.Status == model.SessionStatusVerified {
		response.UserID = session.User.ID
		response.UserName = session.User.Name
	}
	c.JSON(http.StatusOK, response)
}
