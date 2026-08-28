package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"tg_verification_go/src/model/dto"
	"tg_verification_go/src/utils"

	"github.com/gin-gonic/gin"
)

const (
	siteverifyURL           = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	maxTurnstileRequestBody = 4 << 10
)

type siteverifyResponse struct {
	Success  bool     `json:"success"`
	Hostname string   `json:"hostname"`
	Action   string   `json:"action"`
	Errors   []string `json:"error-codes"`
}

type TurnstileLimits struct {
	MaxConcurrent             int
	MaxVerificationsPerMinute int
	MaxAttempts               int
	RetryInterval             time.Duration
}

type TurnstileHandler struct {
	store             *Store
	httpClient        *http.Client
	secret            string
	action            string
	endpoint          string
	verificationSlots chan struct{}
	maxAttempts       int
	retryInterval     time.Duration
	rateMu            sync.Mutex
	rateLimit         int
	rateTokens        float64
	rateUpdated       time.Time
	now               func() time.Time
}

// NewTurnstileHandler creates the Turnstile verification endpoint handler.
func NewTurnstileHandler(stateStore *Store, secret, action string, limits TurnstileLimits) *TurnstileHandler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxConnsPerHost = limits.MaxConcurrent
	transport.MaxIdleConns = limits.MaxConcurrent
	transport.MaxIdleConnsPerHost = limits.MaxConcurrent
	transport.ResponseHeaderTimeout = 8 * time.Second
	return &TurnstileHandler{
		store: stateStore,
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   10 * time.Second,
		},
		secret:            secret,
		action:            action,
		endpoint:          siteverifyURL,
		verificationSlots: make(chan struct{}, limits.MaxConcurrent),
		maxAttempts:       limits.MaxAttempts,
		retryInterval:     limits.RetryInterval,
		rateLimit:         limits.MaxVerificationsPerMinute,
		rateTokens:        float64(limits.MaxVerificationsPerMinute),
		now:               time.Now,
	}
}

// Verify validates a Cloudflare token and issues a session-bound anti-bot token.
func (h *TurnstileHandler) Verify(c *gin.Context) {
	sessionID := c.Param("sid")
	now := h.now()
	switch h.store.beginTurnstile(sessionID, now, h.maxAttempts, h.retryInterval) {
	case turnstileSessionInactive:
		utils.AbortWithError(c, utils.NewError(utils.CodeSessionExpired, "session is missing or expired"))
		return
	case turnstileStageConflict:
		utils.AbortWithError(c, utils.NewError(utils.CodeStateConflict, "anti-bot stage has already been completed for this session"))
		return
	case turnstileAttemptInFlight, turnstileRetryTooSoon:
		utils.AbortWithError(c, utils.NewError(utils.CodeRateLimited, "turnstile verification rate limit reached"))
		return
	case turnstileAttemptsExhausted:
		utils.AbortWithError(c, utils.NewError(utils.CodeStateConflict, "turnstile verification attempt limit reached"))
		return
	}
	defer h.store.finishTurnstileAttempt(sessionID)

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxTurnstileRequestBody)
	var request dto.VerifyTurnstileRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		utils.AbortWithError(c, utils.WrapError(utils.CodeInvalidRequest, "invalid request", err))
		return
	}
	select {
	case h.verificationSlots <- struct{}{}:
		defer func() { <-h.verificationSlots }()
	case <-c.Request.Context().Done():
		return
	default:
		utils.AbortWithError(c, utils.NewError(utils.CodeRateLimited, "turnstile verification capacity reached"))
		return
	}
	attemptedAt := h.now()
	if !h.allowVerification(attemptedAt) {
		utils.AbortWithError(c, utils.NewError(utils.CodeRateLimited, "turnstile verification rate limit reached"))
		return
	}
	h.store.recordTurnstileAttempt(sessionID, attemptedAt)
	if err := h.verifyToken(c.Request.Context(), request.Token, requestHostname(c.Request)); err != nil {
		log.Printf("[turnstile][verify] verification failed: %v", err)
		utils.AbortWithError(c, err)
		return
	}

	antiBotToken, err := utils.NewSecureToken()
	if err != nil {
		log.Printf("[turnstile][token] failed to generate token: %v", err)
		utils.AbortWithError(c, utils.WrapError(utils.CodeInternal, "failed to create anti-bot token", err))
		return
	}
	nonce, err := utils.NewSecureToken()
	if err != nil {
		log.Printf("[turnstile][nonce] failed to generate nonce: %v", err)
		utils.AbortWithError(c, utils.WrapError(utils.CodeInternal, "failed to create Telegram nonce", err))
		return
	}
	antiBotToken, nonce, expiresAt, ok := h.store.PassTurnstile(sessionID, antiBotToken, nonce, h.now())
	if !ok {
		utils.AbortWithError(c, utils.NewError(utils.CodeStateConflict, "anti-bot stage has already been completed for this session"))
		return
	}
	c.JSON(http.StatusOK, dto.VerifyTurnstileResponse{
		AntiBotToken: antiBotToken,
		Nonce:        nonce,
		ExpiresAt:    expiresAt.Unix(),
	})
}

func (h *TurnstileHandler) allowVerification(now time.Time) bool {
	h.rateMu.Lock()
	defer h.rateMu.Unlock()
	if h.rateUpdated.IsZero() {
		h.rateUpdated = now
	} else if now.After(h.rateUpdated) {
		refill := now.Sub(h.rateUpdated).Minutes() * float64(h.rateLimit)
		h.rateTokens = min(float64(h.rateLimit), h.rateTokens+refill)
		h.rateUpdated = now
	}
	if h.rateTokens < 1 {
		return false
	}
	h.rateTokens--
	return true
}

func (h *TurnstileHandler) verifyToken(ctx context.Context, token, expectedHostname string) error {
	form := url.Values{}
	form.Set("secret", h.secret)
	form.Set("response", token)

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return utils.WrapError(utils.CodeTurnstileUnavailable, "turnstile verification service unavailable", fmt.Errorf("create siteverify request: %w", err))
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := h.httpClient.Do(request)
	if err != nil {
		return utils.WrapError(utils.CodeTurnstileUnavailable, "turnstile verification service unavailable", fmt.Errorf("call siteverify: %w", err))
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return utils.WrapError(utils.CodeTurnstileUnavailable, "turnstile verification service unavailable", fmt.Errorf("siteverify returned status %d", response.StatusCode))
	}
	var result siteverifyResponse
	decoder := json.NewDecoder(response.Body)
	if err := decoder.Decode(&result); err != nil {
		return utils.WrapError(utils.CodeTurnstileUnavailable, "turnstile verification service unavailable", fmt.Errorf("decode siteverify response: %w", err))
	}
	if !result.Success {
		return utils.WrapError(utils.CodeTurnstileFailed, "turnstile verification failed", fmt.Errorf("siteverify rejected token: %v", result.Errors))
	}
	if !strings.EqualFold(result.Hostname, expectedHostname) {
		return utils.WrapError(utils.CodeTurnstileFailed, "turnstile verification failed", fmt.Errorf("siteverify hostname mismatch"))
	}
	if result.Action != h.action {
		return utils.WrapError(utils.CodeTurnstileFailed, "turnstile verification failed", fmt.Errorf("siteverify action mismatch"))
	}
	return nil
}

func requestHostname(request *http.Request) string {
	host := request.Host
	if hostname, _, err := net.SplitHostPort(host); err == nil {
		return hostname
	}
	return strings.Trim(host, "[]")
}
