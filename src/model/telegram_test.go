package model

import (
	"encoding/json"
	"testing"
)

func TestTelegramTokenClaimsAcceptsIDRepresentations(t *testing.T) {
	tests := []struct {
		name string
		id   string
	}{
		{"number", `987654321`},
		{"decimal string", `"987654321"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := []byte(`{
				"iss":"https://oauth.telegram.org",
				"aud":"1234567890",
				"sub":"987654321",
				"iat":1700000000,
				"exp":1700003600,
				"id":` + test.id + `,
				"name":"Test User",
				"nonce":"0123456789abcdef0123456789abcdef"
			}`)

			var claims TelegramTokenClaims
			if err := json.Unmarshal(data, &claims); err != nil {
				t.Fatalf("UnmarshalJSON: %v", err)
			}
			if claims.ID != 987654321 {
				t.Fatalf("got ID %d, want 987654321", claims.ID)
			}
		})
	}
}

func TestTelegramTokenClaimsRejectsInvalidID(t *testing.T) {
	data := []byte(`{
		"iss":"https://oauth.telegram.org",
		"aud":"1234567890",
		"sub":"987654321",
		"iat":1700000000,
		"exp":1700003600,
		"id":"not-an-integer",
		"name":"Test User",
		"nonce":"0123456789abcdef0123456789abcdef"
	}`)

	var claims TelegramTokenClaims
	if err := json.Unmarshal(data, &claims); err == nil {
		t.Fatal("UnmarshalJSON accepted a non-integer ID")
	}
}
