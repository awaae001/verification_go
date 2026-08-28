package telegram

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tg_verification_go/src/model"
)

const (
	testClientID = "1234567890"
	testNonce    = "0123456789abcdef0123456789abcdef"
)

type signer interface {
	jwk(keyID string) model.TelegramJWK
	sign(t *testing.T, signingInput string) []byte
}

type rsaSigner struct {
	key *rsa.PrivateKey
}

func newRSASigner(t *testing.T) rsaSigner {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	return rsaSigner{key: key}
}

func (s rsaSigner) jwk(keyID string) model.TelegramJWK {
	return model.TelegramJWK{
		KeyID:     keyID,
		KeyType:   "RSA",
		Algorithm: algRS256,
		Modulus:   base64.RawURLEncoding.EncodeToString(s.key.N.Bytes()),
		Exponent:  base64.RawURLEncoding.EncodeToString(big.NewInt(int64(s.key.E)).Bytes()),
	}
}

func (s rsaSigner) sign(t *testing.T, signingInput string) []byte {
	t.Helper()
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign RS256: %v", err)
	}
	return signature
}

type ecdsaSigner struct {
	key *ecdsa.PrivateKey
}

func newECDSASigner(t *testing.T) ecdsaSigner {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate P-256 key: %v", err)
	}
	return ecdsaSigner{key: key}
}

func (s ecdsaSigner) jwk(keyID string) model.TelegramJWK {
	return model.TelegramJWK{
		KeyID:     keyID,
		KeyType:   "EC",
		Algorithm: algES256,
		Curve:     "P-256",
		X:         base64.RawURLEncoding.EncodeToString(s.key.X.FillBytes(make([]byte, 32))),
		Y:         base64.RawURLEncoding.EncodeToString(s.key.Y.FillBytes(make([]byte, 32))),
	}
}

func (s ecdsaSigner) sign(t *testing.T, signingInput string) []byte {
	t.Helper()
	digest := sha256.Sum256([]byte(signingInput))
	r, sValue, err := ecdsa.Sign(rand.Reader, s.key, digest[:])
	if err != nil {
		t.Fatalf("sign ES256: %v", err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	sValue.FillBytes(signature[32:])
	return signature
}

type ed25519Signer struct {
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

func newEd25519Signer(t *testing.T) ed25519Signer {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate Ed25519 key: %v", err)
	}
	return ed25519Signer{public: public, private: private}
}

func (s ed25519Signer) jwk(keyID string) model.TelegramJWK {
	return model.TelegramJWK{
		KeyID:     keyID,
		KeyType:   "OKP",
		Algorithm: algEdDSA,
		Curve:     "Ed25519",
		X:         base64.RawURLEncoding.EncodeToString(s.public),
	}
}

func (s ed25519Signer) sign(t *testing.T, signingInput string) []byte {
	t.Helper()
	return ed25519.Sign(s.private, []byte(signingInput))
}

func newVerifier(t *testing.T, keys ...model.TelegramJWK) *Verifier {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(model.TelegramJWKS{Keys: keys}); err != nil {
			t.Errorf("encode JWKS: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	verifier := NewVerifier(testClientID)
	verifier.jwksURL = server.URL
	return verifier
}

func newToken(t *testing.T, algorithm, keyID string, keySigner signer, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": algorithm, "kid": keyID, "typ": "JWT"})
	if err != nil {
		t.Fatalf("encode header: %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("encode claims: %v", err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(keySigner.sign(t, signingInput))
}

func validClaims(now time.Time) map[string]any {
	return map[string]any{
		"iss":   issuer,
		"aud":   testClientID,
		"sub":   "42",
		"iat":   now.Add(-time.Minute).Unix(),
		"exp":   now.Add(time.Minute).Unix(),
		"id":    42,
		"name":  "Test User",
		"nonce": testNonce,
	}
}

func TestVerifyAcceptsPublishedAlgorithms(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name      string
		algorithm string
		keyID     string
		signer    func(*testing.T) signer
	}{
		{"RS256", algRS256, "oidc-1", func(t *testing.T) signer { return newRSASigner(t) }},
		{"ES256", algES256, "oidc-es256-1", func(t *testing.T) signer { return newECDSASigner(t) }},
		{"EdDSA", algEdDSA, "oidc-eddsa-1", func(t *testing.T) signer { return newEd25519Signer(t) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			keySigner := test.signer(t)
			verifier := newVerifier(t, keySigner.jwk(test.keyID))
			token := newToken(t, test.algorithm, test.keyID, keySigner, validClaims(now))

			user, err := verifier.Verify(context.Background(), token, testNonce, now)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if user.ID != 42 || user.Name != "Test User" {
				t.Fatalf("got user %+v", user)
			}
		})
	}
}

func TestRejectUnsupportedKeyAlgorithm(t *testing.T) {
	now := time.Now()
	keySigner := newECDSASigner(t)
	key := keySigner.jwk("oidc-es256k-1")
	key.Algorithm = "ES256K"
	key.Curve = "secp256k1"
	verifier := newVerifier(t, key)
	token := newToken(t, "ES256K", "oidc-es256k-1", keySigner, validClaims(now))

	if _, err := verifier.Verify(context.Background(), token, testNonce, now); err == nil {
		t.Fatal("Verify accepted a key algorithm the service cannot check")
	}
}

// The scheme comes from the key set, so a token cannot pick one by rewriting
// its header: here the header claims ES256 while the key ID belongs to an RSA
// key, and the ECDSA signature is checked as RS256 and fails.
func TestHeaderAlgorithmCannotSelectTheScheme(t *testing.T) {
	now := time.Now()
	verifier := newVerifier(t, newRSASigner(t).jwk("oidc-1"))
	token := newToken(t, algES256, "oidc-1", newECDSASigner(t), validClaims(now))

	if _, err := verifier.Verify(context.Background(), token, testNonce, now); err == nil {
		t.Fatal("Verify accepted a token signed with another scheme")
	}
}

func TestRejectTamperedPayload(t *testing.T) {
	now := time.Now()
	keySigner := newRSASigner(t)
	verifier := newVerifier(t, keySigner.jwk("oidc-1"))
	token := newToken(t, algRS256, "oidc-1", keySigner, validClaims(now))

	forged := map[string]any{}
	for name, value := range validClaims(now) {
		forged[name] = value
	}
	forged["id"] = 43
	payload, err := json.Marshal(forged)
	if err != nil {
		t.Fatalf("encode forged claims: %v", err)
	}
	parts := splitToken(t, token)
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString(payload) + "." + parts[2]

	if _, err := verifier.Verify(context.Background(), tampered, testNonce, now); err == nil {
		t.Fatal("Verify accepted a tampered payload")
	}
}

func TestRejectMismatchedNonce(t *testing.T) {
	now := time.Now()
	keySigner := newRSASigner(t)
	verifier := newVerifier(t, keySigner.jwk("oidc-1"))
	token := newToken(t, algRS256, "oidc-1", keySigner, validClaims(now))

	if _, err := verifier.Verify(context.Background(), token, "fedcba9876543210fedcba9876543210", now); err == nil {
		t.Fatal("Verify accepted a token bound to another nonce")
	}
}

func TestRejectExpiredToken(t *testing.T) {
	now := time.Now()
	keySigner := newRSASigner(t)
	verifier := newVerifier(t, keySigner.jwk("oidc-1"))
	claims := validClaims(now)
	claims["iat"] = now.Add(-2 * time.Hour).Unix()
	claims["exp"] = now.Add(-time.Hour).Unix()
	token := newToken(t, algRS256, "oidc-1", keySigner, claims)

	if _, err := verifier.Verify(context.Background(), token, testNonce, now); err == nil {
		t.Fatal("Verify accepted an expired token")
	}
}

func TestRejectUnknownKeyID(t *testing.T) {
	now := time.Now()
	keySigner := newRSASigner(t)
	verifier := newVerifier(t, keySigner.jwk("oidc-1"))
	token := newToken(t, algRS256, "oidc-unknown", keySigner, validClaims(now))

	if _, err := verifier.Verify(context.Background(), token, testNonce, now); err == nil {
		t.Fatal("Verify accepted a token signed with an unknown key ID")
	}
}

func splitToken(t *testing.T, token string) []string {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d segments, want 3", len(parts))
	}
	return parts
}
