package handler

import (
	"log"
	"net/http"
	"strings"

	"tg_verification_go/src/middleware"
	"tg_verification_go/src/model"
	"tg_verification_go/src/model/dto"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

// CreateSession creates a pending verification session for an authenticated client.
func (h *Handler) CreateSession(c *gin.Context) {
	now := h.now()
	for attempts := 0; attempts < 3; attempts++ {
		sessionID, err := utils.NewSecureToken()
		if err != nil {
			log.Printf("[handle][session] failed to generate session ID: %v", err)
			utils.AbortWithError(c, utils.WrapError(utils.CodeInternal, "failed to create session", err))
			return
		}
		session := model.Session{
			ID:        sessionID,
			Client:    middleware.ClientName(c),
			Status:    model.SessionStatusPending,
			CreatedAt: now,
			ExpiresAt: now.Add(h.store.TTL()),
		}
		if !h.store.PutSession(session) {
			continue
		}
		baseURL := strings.TrimRight(h.config.PublicBaseURL, "/")
		if baseURL == "" {
			scheme := "http"
			if c.Request.TLS != nil {
				scheme = "https"
			}
			baseURL = scheme + "://" + c.Request.Host
		}
		c.JSON(http.StatusCreated, dto.CreateSessionResponse{
			SessionID: sessionID,
			VerifyURL: baseURL + "/v/" + sessionID,
			ExpiresAt: session.ExpiresAt.Unix(),
		})
		return
	}
	utils.AbortWithError(c, utils.NewError(utils.CodeInternal, "failed to allocate session ID"))
}
