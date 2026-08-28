package middleware

import (
	"tg_verification_go/src/model"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

const clientContextKey = "trusted-client"

// ClientAuth authenticates bot clients through X-Client-Key.
func ClientAuth(config *model.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		client, ok := config.IsTrustedClient(c.GetHeader("X-Client-Key"))
		if !ok {
			utils.AbortWithError(c, utils.NewError(utils.CodeUnauthorizedClient, "invalid client key"))
			return
		}
		c.Set(clientContextKey, client)
		c.Next()
	}
}

// ClientName returns the authenticated client name stored by ClientAuth.
func ClientName(c *gin.Context) string {
	client, _ := c.Get(clientContextKey)
	name, _ := client.(string)
	return name
}
