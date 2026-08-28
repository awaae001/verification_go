package cmd

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// newRouter builds the HTTP engine and registers the full route table.
func newRouter() *gin.Engine {
	r := gin.Default()

	r.GET("/", func(c *gin.Context) {
		c.String(http.StatusOK, "helloworld")
	})

	return r
}
