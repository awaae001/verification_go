package middleware

import (
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

// ErrorHandler is the single HTTP error-response boundary for the API.
func ErrorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		if c.Writer.Written() || len(c.Errors) == 0 {
			return
		}
		status, response := utils.HTTPError(c.Errors.Last().Err)
		c.JSON(status, response)
	}
}
