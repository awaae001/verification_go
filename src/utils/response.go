package utils

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

type ErrorCode string

const (
	CodeInvalidRequest             ErrorCode = "INVALID_REQUEST"
	CodeUnauthorizedClient         ErrorCode = "UNAUTHORIZED_CLIENT"
	CodeSessionNotFound            ErrorCode = "SESSION_NOT_FOUND"
	CodeSessionExpired             ErrorCode = "SESSION_EXPIRED"
	CodeTurnstileFailed            ErrorCode = "TURNSTILE_FAILED"
	CodeTurnstileUnavailable       ErrorCode = "TURNSTILE_UNAVAILABLE"
	CodeTurnstileAttemptsExhausted ErrorCode = "TURNSTILE_ATTEMPTS_EXHAUSTED"
	CodeAntiBotRequired            ErrorCode = "ANTIBOT_REQUIRED"
	CodeTelegramTokenInvalid       ErrorCode = "TELEGRAM_TOKEN_INVALID"
	CodeTelegramKeyUnavailable     ErrorCode = "TELEGRAM_KEY_UNAVAILABLE"
	CodeStateConflict              ErrorCode = "STATE_CONFLICT"
	CodeRateLimited                ErrorCode = "RATE_LIMITED"
	CodePoWSolutionInvalid         ErrorCode = "POW_SOLUTION_INVALID"
	CodeInternal                   ErrorCode = "INTERNAL_ERROR"
)

type ErrorInfo struct {
	Message string `json:"message"`
}

type ErrorResponse struct {
	Code ErrorCode `json:"code"`
	Info ErrorInfo `json:"info"`
}

type AppError struct {
	Code  ErrorCode
	Info  ErrorInfo
	cause error
}

// NewError creates a structured application error.
func NewError(code ErrorCode, message string) *AppError {
	return &AppError{Code: code, Info: ErrorInfo{Message: message}}
}

// WrapError creates a structured application error that retains its cause.
func WrapError(code ErrorCode, message string, cause error) *AppError {
	return &AppError{Code: code, Info: ErrorInfo{Message: message}, cause: cause}
}

// Error implements error.
func (e *AppError) Error() string {
	if e.cause == nil {
		return e.Info.Message
	}
	return e.Info.Message + ": " + e.cause.Error()
}

// Unwrap returns the underlying error.
func (e *AppError) Unwrap() error {
	return e.cause
}

// AbortWithError stops the handler chain and delegates the response to the
// global error middleware.
func AbortWithError(c *gin.Context, err error) {
	_ = c.Error(err)
	c.Abort()
}

// HTTPError converts any application error into the public API envelope. Raw
// errors are deliberately hidden from clients.
func HTTPError(err error) (int, ErrorResponse) {
	var appError *AppError
	if !errors.As(err, &appError) {
		return http.StatusInternalServerError, ErrorResponse{
			Code: CodeInternal,
			Info: ErrorInfo{Message: "internal server error"},
		}
	}

	return statusForCode(appError.Code), ErrorResponse{
		Code: appError.Code,
		Info: appError.Info,
	}
}

func statusForCode(code ErrorCode) int {
	switch code {
	case CodeInvalidRequest:
		return http.StatusBadRequest
	case CodeUnauthorizedClient, CodeAntiBotRequired, CodeTelegramTokenInvalid:
		return http.StatusUnauthorized
	case CodeSessionNotFound:
		return http.StatusNotFound
	case CodeTurnstileFailed:
		return http.StatusForbidden
	case CodeStateConflict, CodeTurnstileAttemptsExhausted:
		return http.StatusConflict
	case CodeRateLimited:
		return http.StatusTooManyRequests
	case CodeSessionExpired:
		return http.StatusGone
	case CodePoWSolutionInvalid:
		return http.StatusUnprocessableEntity
	case CodeTurnstileUnavailable, CodeTelegramKeyUnavailable:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}
