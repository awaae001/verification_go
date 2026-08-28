package handler

import (
	"log"
	"net/http"
	"strings"
	"time"

	"tg_verification_go/src/middleware"
	"tg_verification_go/src/model"
	"tg_verification_go/src/model/dto"
	"tg_verification_go/src/service"
	powservice "tg_verification_go/src/service/pow"
	telegramservice "tg_verification_go/src/service/telegram"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
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
		c.JSON(http.StatusCreated, dto.CreateSessionResponse{
			SessionID: sessionID,
			VerifyURL: h.verificationURL(c.Request, sessionID),
			ExpiresAt: session.ExpiresAt.Unix(),
		})
		return
	}
	utils.AbortWithError(c, utils.NewError(utils.CodeInternal, "failed to allocate session ID"))
}

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

// CreateChallenge exchanges a one-time PoW token for a challenge.
func (h *Handler) CreateChallenge(c *gin.Context) {
	sessionID := c.Param("sid")
	var request dto.CreateChallengeRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		utils.AbortWithError(c, utils.WrapError(utils.CodeInvalidRequest, "invalid request", err))
		return
	}
	challenge, err := utils.NewSecureToken()
	if err != nil {
		log.Printf("[handle][pow] failed to generate challenge: %v", err)
		utils.AbortWithError(c, utils.WrapError(utils.CodeInternal, "failed to create challenge", err))
		return
	}
	if !h.store.IssueChallenge(sessionID, request.PoWToken, challenge, h.now()) {
		utils.AbortWithError(c, utils.NewError(utils.CodeStateConflict, "PoW token is missing, expired, or already consumed"))
		return
	}
	c.JSON(http.StatusOK, dto.CreateChallengeResponse{
		Challenge:   challenge,
		Difficulty:  h.config.PoW.Difficulty,
		MaximumWork: h.config.PoW.MaximumWork,
	})
}

// VerifyPoW validates a solution and completes the verification session.
func (h *Handler) VerifyPoW(c *gin.Context) {
	sessionID := c.Param("sid")
	var request dto.VerifyPoWRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		utils.AbortWithError(c, utils.WrapError(utils.CodeInvalidRequest, "invalid request", err))
		return
	}
	if request.Solution < 0 || request.Solution >= h.config.PoW.MaximumWork {
		utils.AbortWithError(c, utils.NewError(utils.CodePoWSolutionInvalid, "solution is outside the work space"))
		return
	}
	now := h.now()
	if !h.store.HasChallenge(sessionID, request.Challenge, now) {
		utils.AbortWithError(c, utils.NewError(utils.CodeStateConflict, "challenge is missing, expired, or already consumed"))
		return
	}
	if !powservice.Verify(request.Challenge, request.Solution, h.config.PoW.Difficulty) {
		utils.AbortWithError(c, utils.NewError(utils.CodePoWSolutionInvalid, "incorrect PoW solution"))
		return
	}
	if !h.store.CompleteChallenge(sessionID, request.Challenge, now) {
		utils.AbortWithError(c, utils.NewError(utils.CodeStateConflict, "challenge was already consumed"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Handler) verificationURL(request *http.Request, sessionID string) string {
	baseURL := strings.TrimRight(h.config.PublicBaseURL, "/")
	if baseURL == "" {
		scheme := "http"
		if request.TLS != nil {
			scheme = "https"
		}
		baseURL = scheme + "://" + request.Host
	}
	return baseURL + "/v/" + sessionID
}
