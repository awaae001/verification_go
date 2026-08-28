package pow

import (
	"crypto/sha256"
	"strconv"
)

// Verify reports whether solution produces a challenge digest with difficulty
// leading zero hex digits. Difficulty must be positive and at most 64 (the hex
// digit count of a SHA-256 digest); configuration loading enforces both bounds.
func Verify(challenge string, solution int64, difficulty int) bool {
	digest := sha256.Sum256([]byte(challenge + strconv.FormatInt(solution, 10)))
	fullBytes := difficulty / 2
	for index := 0; index < fullBytes; index++ {
		if digest[index] != 0 {
			return false
		}
	}
	return difficulty%2 == 0 || digest[fullBytes]>>4 == 0
}
