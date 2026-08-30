/**
 * 数据模型类型定义
 */

export type SessionStatus = 'pending' | 'verified' | 'expired'

export type VerificationStage =
  | 'created'
  | 'antibot_passed'
  | 'telegram_passed'
  | 'challenge_issued'
  | 'verified'

export interface Session {
  id: string
  client: string
  status: SessionStatus
  createdAt: number
  expiresAt: number
  verifiedAt?: number
  user?: TelegramUser
}

export interface SessionState {
  session: Session
  stage: VerificationStage
  antiBotToken?: string
  nonce?: string
  powToken?: string
  challenge?: string
  user?: TelegramUser
  turnstileInFlight: boolean
  turnstileAttempts: number
  turnstileLastAttempt?: number
}

export interface TelegramUser {
  id: number
  name: string
}

export interface TelegramTokenClaims {
  iss: string
  aud: string
  sub: string
  iat: number
  exp: number
  id: number
  name: string
  nonce: string
}

// API Request/Response DTOs

export interface CreateSessionResponse {
  session_id: string
  verify_url: string
  expires_at: number
}

export interface SessionStatusResponse {
  session_id: string
  status: SessionStatus
  user_id?: number
  user_name?: string
}

export interface VerifyTurnstileRequest {
  token: string
}

export interface VerifyTurnstileResponse {
  antibot_token: string
  nonce: string
  expires_at: number
}

export interface VerifyTelegramRequest {
  nonce: string
  id_token: string
}

export interface VerifyTelegramResponse {
  pow_token: string
}

export interface CreateChallengeRequest {
  pow_token: string
}

export interface CreateChallengeResponse {
  challenge: string
  difficulty: number
  maximum_work: number
}

export interface VerifyPoWRequest {
  challenge: string
  solution: number
}

// Turnstile API Response

export interface TurnstileVerifyResponse {
  success: boolean
  'error-codes'?: string[]
  challenge_ts?: string
  hostname?: string
  action?: string
  cdata?: string
}

// Error Codes

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_EXISTS'
  | 'SESSION_CAPACITY_REACHED'
  | 'CLIENT_SESSION_CAPACITY_REACHED'
  | 'INVALID_ANTIBOT_TOKEN'
  | 'INVALID_NONCE'
  | 'INVALID_POW_TOKEN'
  | 'INVALID_CHALLENGE'
  | 'INVALID_TELEGRAM_TOKEN'
  | 'INVALID_POW_SOLUTION'
  | 'STATE_CONFLICT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'TURNSTILE_ATTEMPTS_EXHAUSTED'
  | 'TURNSTILE_RETRY_TOO_SOON'
  | 'TURNSTILE_IN_FLIGHT'
  | 'INTERNAL_ERROR'

export interface ErrorResponse {
  code: ErrorCode
  info: {
    message: string
    [key: string]: any
  }
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 400,
    public info?: Record<string, any>
  ) {
    super(message)
    this.name = 'AppError'
  }
}
