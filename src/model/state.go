package model

// Ephemeral one-time states. The random token (cData, nonce, PoW token, challenge) is the store key;
// these structs are the stored values.

type TurnstileState struct {
	SessionID string
	Nonce     string
}

type NonceState struct {
	SessionID string
}

type PoWTokenState struct {
	SessionID string
	User      TelegramUser
}

type ChallengeState struct {
	SessionID string
	User      TelegramUser
}
