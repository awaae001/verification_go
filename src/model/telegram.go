package model

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

type TelegramUser struct {
	ID   int64
	Name string
}

type TelegramTokenHeader struct {
	KeyID string `json:"kid"`
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
		Issuer   *string         `json:"iss"`
		Audience *string         `json:"aud"`
		Subject  *string         `json:"sub"`
		IssuedAt *int64          `json:"iat"`
		Expires  *int64          `json:"exp"`
		ID       json.RawMessage `json:"id"`
		Name     *string         `json:"name"`
		Nonce    *string         `json:"nonce"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.Issuer == nil || raw.Audience == nil || raw.Subject == nil ||
		raw.IssuedAt == nil || raw.Expires == nil || len(raw.ID) == 0 ||
		raw.Name == nil || raw.Nonce == nil {
		return errors.New("missing required claim")
	}
	id, err := parseTelegramID(raw.ID)
	if err != nil {
		return fmt.Errorf("invalid id claim: %w", err)
	}
	*c = TelegramTokenClaims{
		Issuer:   *raw.Issuer,
		Audience: *raw.Audience,
		Subject:  *raw.Subject,
		IssuedAt: *raw.IssuedAt,
		Expires:  *raw.Expires,
		ID:       id,
		Name:     *raw.Name,
		Nonce:    *raw.Nonce,
	}
	return nil
}

func parseTelegramID(data json.RawMessage) (int64, error) {
	value := bytes.TrimSpace(data)
	if len(value) > 0 && value[0] == '"' {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return 0, err
		}
		return strconv.ParseInt(text, 10, 64)
	}
	return strconv.ParseInt(string(value), 10, 64)
}

type TelegramJWK struct {
	KeyID     string `json:"kid"`
	KeyType   string `json:"kty"`
	Algorithm string `json:"alg"`
	Curve     string `json:"crv"`
	X         string `json:"x"`
	Y         string `json:"y"`
	Modulus   string `json:"n"`
	Exponent  string `json:"e"`
}

type TelegramJWKS struct {
	Keys []TelegramJWK `json:"keys"`
}
