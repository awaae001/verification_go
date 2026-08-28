package middleware

import (
	"time"

	"tg_verification_go/src/service"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

const antiBotHeader = "X-Anti-Bot-Token"

type AntiBot struct {
	store *service.Store
	now   func() time.Time
}

// NewAntiBot creates middleware that validates session-bound anti-bot tokens.
func NewAntiBot(stateStore *service.Store) *AntiBot {
	return &AntiBot{store: stateStore, now: time.Now}
}

// Protect rejects browser verification requests without a valid anti-bot token.
func (m *AntiBot) Protect(c *gin.Context) {
	token := c.GetHeader(antiBotHeader)
	if !m.store.CheckAntiBot(token, c.Param("sid"), m.now()) {
		utils.AbortWithError(c, utils.NewError(utils.CodeAntiBotRequired, "invalid anti-bot token"))
		return
	}
	c.Next()
}
