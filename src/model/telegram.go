package model

import (
	"encoding/json"
	"errors"
)

type TelegramUser struct {
	ID   int64
	Name string
}

type TelegramTokenHeader struct {
	Algorithm string `json:"alg"`
	KeyID     string `json:"kid"`
}

type TelegramTokenClaims struct {
	Issuer   string
	Audience string
	Subject  string
	IssuedAt int64
	Expires  int64
	ID       int64
	Name     string
	Nonce    string
}

// UnmarshalJSON decodes ID token claims, failing when any required claim is absent.
func (c *TelegramTokenClaims) UnmarshalJSON(data []byte) error {
	// The shadow struct uses pointers to distinguish absent claims from zero
	// values; it deliberately has no methods, so decoding it does not recurse.
	var raw struct {
		Issuer   *string `json:"iss"`
		Audience *string `json:"aud"`
		Subject  *string `json:"sub"`
		IssuedAt *int64  `json:"iat"`
		Expires  *int64  `json:"exp"`
		ID       *int64  `json:"id"`
		Name     *string `json:"name"`
		Nonce    *string `json:"nonce"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.Issuer == nil || raw.Audience == nil || raw.Subject == nil ||
		raw.IssuedAt == nil || raw.Expires == nil || raw.ID == nil ||
		raw.Name == nil || raw.Nonce == nil {
		return errors.New("missing required claim")
	}
	*c = TelegramTokenClaims{
		Issuer:   *raw.Issuer,
		Audience: *raw.Audience,
		Subject:  *raw.Subject,
		IssuedAt: *raw.IssuedAt,
		Expires:  *raw.Expires,
		ID:       *raw.ID,
		Name:     *raw.Name,
		Nonce:    *raw.Nonce,
	}
	return nil
}

type TelegramJWK struct {
	X     string `json:"x"`
	Y     string `json:"y"`
	KeyID string `json:"kid"`
}

type TelegramJWKS struct {
	Keys []TelegramJWK `json:"keys"`
}
