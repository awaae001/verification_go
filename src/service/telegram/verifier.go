package telegram

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"tg_verification_go/src/model"
	"tg_verification_go/src/utils"
)

const (
	issuer              = "https://oauth.telegram.org"
	defaultJWKS         = "https://oauth.telegram.org/.well-known/jwks.json"
	jwksCacheTTL        = time.Hour
	jwksRefreshCooldown = time.Minute
)

type Verifier struct {
	client   *http.Client
	clientID string
	jwksURL  string

	mu                 sync.Mutex
	keys               []model.TelegramJWK
	fetchedAt          time.Time
	lastRefreshAttempt time.Time
}

// NewVerifier creates a Telegram OIDC ID token verifier.
func NewVerifier(clientID string) *Verifier {
	return &Verifier{
		client:   &http.Client{Timeout: 10 * time.Second},
		clientID: clientID,
		jwksURL:  defaultJWKS,
	}
}

// Verify validates an ID token and returns the authenticated Telegram user.
func (v *Verifier) Verify(ctx context.Context, rawToken, expectedNonce string, now time.Time) (model.TelegramUser, error) {
	parts := strings.Split(rawToken, ".")
	if len(parts) != 3 {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "ID token must contain three segments")
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return model.TelegramUser{}, utils.WrapError(utils.CodeTelegramTokenInvalid, "decode token header", err)
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return model.TelegramUser{}, utils.WrapError(utils.CodeTelegramTokenInvalid, "decode token payload", err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return model.TelegramUser{}, utils.WrapError(utils.CodeTelegramTokenInvalid, "decode token signature", err)
	}

	var header model.TelegramTokenHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return model.TelegramUser{}, utils.WrapError(utils.CodeTelegramTokenInvalid, "decode token header JSON", err)
	}
	if header.Algorithm != "ES256" {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "unsupported token algorithm")
	}
	if header.KeyID == "" {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "token key ID is missing")
	}
	key, err := v.key(ctx, header.KeyID, now)
	if err != nil {
		return model.TelegramUser{}, err
	}
	publicKey, err := publicKey(key)
	if err != nil {
		return model.TelegramUser{}, err
	}
	if len(signature) != 64 {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "invalid ES256 signature length")
	}

	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(publicKey, digest[:], r, s) {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "invalid ID token signature")
	}

	var claims model.TelegramTokenClaims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return model.TelegramUser{}, utils.WrapError(utils.CodeTelegramTokenInvalid, "decode token claims", err)
	}
	if claims.Issuer != issuer {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "invalid token issuer")
	}
	if claims.Audience != v.clientID {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "invalid token audience")
	}
	if claims.Subject == "" {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "token subject is missing")
	}
	if claims.IssuedAt >= claims.Expires {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "invalid token time range")
	}
	if claims.IssuedAt > now.Unix() {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "token was issued in the future")
	}
	if claims.Expires <= now.Unix() {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "token is expired")
	}
	if claims.Nonce != expectedNonce {
		return model.TelegramUser{}, utils.NewError(utils.CodeTelegramTokenInvalid, "invalid token nonce")
	}

	return model.TelegramUser{ID: claims.ID, Name: claims.Name}, nil
}

func (v *Verifier) key(ctx context.Context, keyID string, now time.Time) (model.TelegramJWK, error) {
	v.mu.Lock()
	cachedKey, keyFound := findKey(v.keys, keyID)
	cacheFresh := len(v.keys) > 0 && now.Sub(v.fetchedAt) < jwksCacheTTL
	if cacheFresh {
		v.mu.Unlock()
		if keyFound {
			return cachedKey, nil
		}
		return model.TelegramJWK{}, utils.NewError(utils.CodeTelegramTokenInvalid, "no Telegram key matches token key ID")
	}
	if !v.lastRefreshAttempt.IsZero() && now.Sub(v.lastRefreshAttempt) < jwksRefreshCooldown {
		v.mu.Unlock()
		if keyFound {
			return cachedKey, nil
		}
		return model.TelegramJWK{}, utils.NewError(utils.CodeTelegramKeyUnavailable, "Telegram JWKS refresh is in progress")
	}
	v.lastRefreshAttempt = now
	v.mu.Unlock()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return model.TelegramJWK{}, utils.WrapError(utils.CodeTelegramKeyUnavailable, "create JWKS request", err)
	}
	response, err := v.client.Do(request)
	if err != nil {
		return model.TelegramJWK{}, utils.WrapError(utils.CodeTelegramKeyUnavailable, "fetch Telegram JWKS", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return model.TelegramJWK{}, utils.NewError(
			utils.CodeTelegramKeyUnavailable,
			"Telegram JWKS returned status "+strconv.Itoa(response.StatusCode),
		)
	}

	var document model.TelegramJWKS
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(&document); err != nil {
		return model.TelegramJWK{}, utils.WrapError(utils.CodeTelegramKeyUnavailable, "decode Telegram JWKS", err)
	}
	if len(document.Keys) == 0 {
		return model.TelegramJWK{}, utils.NewError(utils.CodeTelegramKeyUnavailable, "Telegram JWKS contains no keys")
	}

	v.mu.Lock()
	v.keys = document.Keys
	v.fetchedAt = now
	key, found := findKey(v.keys, keyID)
	v.mu.Unlock()
	if found {
		return key, nil
	}
	return model.TelegramJWK{}, utils.NewError(utils.CodeTelegramTokenInvalid, "no Telegram key matches token key ID")
}

func publicKey(key model.TelegramJWK) (*ecdsa.PublicKey, error) {
	xBytes, err := base64.RawURLEncoding.DecodeString(key.X)
	if err != nil {
		return nil, utils.WrapError(utils.CodeTelegramKeyUnavailable, "decode Telegram JWK x coordinate", err)
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(key.Y)
	if err != nil {
		return nil, utils.WrapError(utils.CodeTelegramKeyUnavailable, "decode Telegram JWK y coordinate", err)
	}
	// The key set is fetched from Telegram over HTTPS and is trusted. Malformed
	// coordinates fail closed: ecdsa.Verify rejects points that are not on P-256.
	return &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(xBytes),
		Y:     new(big.Int).SetBytes(yBytes),
	}, nil
}

func findKey(keys []model.TelegramJWK, keyID string) (model.TelegramJWK, bool) {
	for _, key := range keys {
		if key.KeyID == keyID {
			return key, true
		}
	}
	return model.TelegramJWK{}, false
}
