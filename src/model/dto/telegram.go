package dto

type VerifyTelegramRequest struct {
	Nonce   string `json:"nonce" binding:"required"`
	IDToken string `json:"id_token" binding:"required"`
}

type VerifyTelegramResponse struct {
	PoWToken string `json:"pow_token"`
}
