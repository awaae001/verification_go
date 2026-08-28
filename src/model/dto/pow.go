package dto

type CreateChallengeRequest struct {
	PoWToken string `json:"pow_token" binding:"required"`
}

type CreateChallengeResponse struct {
	Challenge   string `json:"challenge"`
	Difficulty  int    `json:"difficulty"`
	MaximumWork int64  `json:"maximum_work"`
}

type VerifyPoWRequest struct {
	Challenge string `json:"challenge" binding:"required"`
	// zero is a valid solution, so no binding:"required" here
	Solution int64 `json:"solution"`
}
