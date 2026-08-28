package dto

type VerifyTurnstileRequest struct {
	Token string `json:"token" binding:"required"`
}

type VerifyTurnstileResponse struct {
	AntiBotToken string `json:"antibot_token"`
	Nonce        string `json:"nonce"`
	ExpiresAt    int64  `json:"expires_at"`
}
