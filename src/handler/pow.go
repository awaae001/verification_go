package handler

import (
	"log"
	"net/http"

	"tg_verification_go/src/model/dto"
	powservice "tg_verification_go/src/service/pow"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

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
