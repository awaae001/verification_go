package utils

import (
	"crypto/rand"
	"fmt"
)

const tokenAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

// NewSecureToken returns a cryptographically random 32-character alphanumeric token.
func NewSecureToken() (string, error) {
	const length = 32
	const unbiasedLimit = 256 - 256%len(tokenAlphabet)

	token := make([]byte, 0, length)
	buffer := make([]byte, length)
	for len(token) < length {
		if _, err := rand.Read(buffer); err != nil {
			return "", fmt.Errorf("read random bytes: %w", err)
		}
		for _, value := range buffer {
			if int(value) >= unbiasedLimit {
				continue
			}
			token = append(token, tokenAlphabet[int(value)%len(tokenAlphabet)])
			if len(token) == length {
				break
			}
		}
	}
	return string(token), nil
}
