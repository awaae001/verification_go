package dto

type VerifyTurnstileRequest struct {
	CData string `json:"cdata" binding:"required"`
	Token string `json:"token" binding:"required"`
}

// Success is reported as 204 No Content: the page already holds the Telegram
// nonce from render time, so there is nothing to return.
