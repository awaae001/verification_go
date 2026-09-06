/**
 * API 处理器 - 会话管理
 * 对应 Go 版本的 handler
 */

import type { Context } from 'hono'
import type { Env, Config, Variables } from '../types/env'
import type {
  CreateSessionResponse,
  SessionStatusResponse,
  VerifyTurnstileRequest,
  VerifyTurnstileResponse,
  VerifyTelegramRequest,
  VerifyTelegramResponse,
  CreateChallengeRequest,
  CreateChallengeResponse,
  VerifyPoWRequest,
  ErrorResponse,
} from '../types/models'
import { AppError } from '../types/models'
import { generateSecureToken } from '../utils/token'
import { TurnstileService, getRequestHostname } from '../services/turnstile'
import { TelegramVerifier } from '../services/telegram'
import { verifyPoW } from '../utils/pow'

/**
 * 获取会话对应的 Durable Object stub
 */
function getSessionStub(c: Context<{ Bindings: Env; Variables: Variables }>, sessionId: string) {
  const id = c.env.SESSIONS.idFromName(sessionId)
  return c.env.SESSIONS.get(id)
}

/**
 * 获取全局限速器 Durable Object stub（单例，固定 ID）
 */
function getRateLimiterStub(c: Context<{ Bindings: Env; Variables: Variables }>) {
  // 使用固定 ID 保证全局唯一实例
  const id = c.env.RATE_LIMITER.idFromName('global')
  return c.env.RATE_LIMITER.get(id)
}

/**
 * POST /api/sessions - 创建新会话
 */
export async function createSession(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const client = c.get('client')

  // 对齐 Go store.go:90-106: 会话容量限制检查
  const limiterStub = getRateLimiterStub(c)
  const quotaResp = await limiterStub.fetch('http://internal/acquire-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client,
      maxTotal: config.session.maxTotal,
      maxPerClient: config.session.maxPerClient,
    }),
  })

  if (!quotaResp.ok) {
    throw new AppError('INTERNAL_ERROR', 'rate limiter unavailable', 500)
  }

  const quota = await quotaResp.json<{ ok: boolean; error?: string }>()
  if (!quota.ok) {
    if (quota.error === 'session_capacity') {
      throw new AppError(
        'SESSION_CAPACITY_EXCEEDED',
        'global session capacity exceeded',
        503
      )
    }
    if (quota.error === 'client_session_capacity') {
      throw new AppError(
        'CLIENT_SESSION_CAPACITY_EXCEEDED',
        'client session capacity exceeded',
        429
      )
    }
    throw new AppError('INTERNAL_ERROR', 'rate limiter error', 500)
  }

  // 计算过期时间（对齐 Go: Unix 秒，handler/session.go:57）
  const now = Date.now()
  const expiresAt = Math.floor(now / 1000) + config.session.ttlSeconds

  // 对齐 Go session.go:48-53: 会话 ID 冲突时重试（最多 3 次）
  let sessionId: string = ''
  let response: Response | null = null

  for (let attempt = 0; attempt < 3; attempt++) {
    sessionId = generateSecureToken()
    const attemptStub = getSessionStub(c, sessionId)
    response = await attemptStub.fetch('http://internal/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        client,
        expiresAt: expiresAt * 1000,
      }),
    })

    // 成功或非冲突错误都直接跳出
    if (response.ok || response.status !== 409) break
  }

  if (!response || !response.ok) {
    // 创建失败，释放已获取的会话配额
    await limiterStub.fetch('http://internal/release-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client }),
    })

    if (response) {
      const error = (await response.json()) as any
      throw new AppError(error.code, error.info.message, response.status)
    }
    throw new AppError('INTERNAL_ERROR', 'failed to create session', 500)
  }

  // 生成验证 URL（对齐 Go 的 /v/:id 路径）
  const verifyUrl = `${config.baseUrl}/v/${sessionId}`

  const result: CreateSessionResponse = {
    session_id: sessionId,
    verify_url: verifyUrl,
    expires_at: expiresAt,
  }

  return c.json(result, 201)
}

/**
 * GET /api/sessions/:sid/status - 获取会话状态
 */
export async function getSessionStatus(
  c: Context<{ Bindings: Env; Variables: Variables }>
): Promise<Response> {
  const sessionId = c.req.param('sid')!
  const client = c.get('client')

  const stub = getSessionStub(c, sessionId)
  const response = await stub.fetch('http://internal/get')

  if (!response.ok) {
    const error = (await response.json()) as any
    throw new AppError(error.code, error.info.message, response.status)
  }

  const session = (await response.json()) as any

  // 对齐 Go: 校验会话归属（handler/session.go:35-37）
  if (session.client !== client) {
    throw new AppError('SESSION_NOT_FOUND', 'session not found', 404)
  }

  const result: SessionStatusResponse = {
    session_id: session.id,
    status: session.status,
  }

  // 对齐 Go status.go:22-26: 仅 verified 状态才填充 user 字段
  if (session.status === 'verified' && session.user) {
    result.user_id = session.user.id
    result.user_name = session.user.name
  }

  return c.json(result)
}

/**
 * POST /api/sessions/:sid/antibot - 验证 Turnstile
 */
export async function verifyTurnstile(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid')!
  // 对齐 Go turnstile.go:23,98: 限制请求体 4KB
  const rawBody = await c.req.raw.text()
  if (rawBody.length > 4096) {
    throw new AppError('INVALID_REQUEST', 'request body too large', 400)
  }
  const body: VerifyTurnstileRequest = JSON.parse(rawBody)

  if (!body.token) {
    throw new AppError('INVALID_REQUEST', 'missing turnstile token', 400)
  }

  const stub = getSessionStub(c, sessionId)

  // 对齐 Go turnstile.go:104-117: 全局并发 + 令牌桶速率限制
  const limiterStub = getRateLimiterStub(c)
  const turnstileQuotaResp = await limiterStub.fetch('http://internal/acquire-turnstile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      maxConcurrent: config.turnstile.maxConcurrent,
      maxPerMinute: config.turnstile.maxPerMinute,
      sessionId,
    }),
  })

  if (!turnstileQuotaResp.ok) {
    throw new AppError('INTERNAL_ERROR', 'rate limiter unavailable', 500)
  }

  const turnstileQuota = await turnstileQuotaResp.json<{ ok: boolean; error?: string }>()
  if (!turnstileQuota.ok) {
    // capacity = 并发已满, rate_limited = 令牌桶空
    throw new AppError(
      'RATE_LIMITED',
      turnstileQuota.error === 'capacity'
        ? 'turnstile verification at capacity, try again later'
        : 'turnstile verification rate limit reached',
      429
    )
  }

  // 1. 原子性检查 - 开始 Turnstile 验证
  const beginResp = await stub.fetch('http://internal/begin-turnstile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      maxAttempts: config.turnstile.maxAttempts,
      retryIntervalMs: config.turnstile.retryIntervalMs,
    }),
  })

  const beginResult = await beginResp.json<{ result: string }>()

  // 对齐 Go turnstile.go:85-95 的错误码映射
  // 注意：这些 throw 在 try 块之外，需要手动释放限速 slot
  let beginError: AppError | null = null
  if (beginResult.result === 'session_inactive') {
    beginError = new AppError('SESSION_EXPIRED', 'session is missing or expired', 404)
  } else if (beginResult.result === 'attempt_in_flight' || beginResult.result === 'retry_too_soon') {
    beginError = new AppError('RATE_LIMITED', 'turnstile verification rate limit reached', 429)
  } else if (beginResult.result === 'attempts_exhausted') {
    beginError = new AppError(
      'TURNSTILE_ATTEMPTS_EXHAUSTED',
      'turnstile verification attempt limit reached',
      409
    )
  }

  if (beginError) {
    // 释放限速 slot 后再抛出
    await limiterStub.fetch('http://internal/release-turnstile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    throw beginError
  }

  try {
    // 2. 记录尝试
    await stub.fetch('http://internal/record-turnstile', { method: 'POST' })

    // 3. 调用 Turnstile API 验证
    const turnstileService = new TurnstileService({
      secret: config.turnstile.secret,
      action: config.turnstile.action,
    })

    const hostname = getRequestHostname(c.req.raw)
    await turnstileService.verify(body.token, hostname)

    // 4. 生成 antibot token 和 nonce
    const antiBotToken = generateSecureToken()
    const nonce = generateSecureToken()

    // 5. 更新会话状态
    const passResp = await stub.fetch('http://internal/pass-turnstile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        antiBotToken,
        nonce,
      }),
    })

    if (!passResp.ok) {
      const error = (await passResp.json()) as any
      throw new AppError(error.code, error.info.message, passResp.status)
    }

    const doResult = await passResp.json<{
      antiBotToken: string
      nonce: string
      expiresAt: number
    }>()

    // 对齐 Go: expires_at 返回 Unix 秒（turnstile.go:145）
    const result: VerifyTurnstileResponse = {
      antibot_token: doResult.antiBotToken,
      nonce: doResult.nonce,
      expires_at: Math.floor(doResult.expiresAt / 1000),
    }

    return c.json(result)
  } finally {
    // 6. 无论成功失败，都要清除 in-flight 标志
    await stub.fetch('http://internal/finish-turnstile', { method: 'POST' })

    // 释放 Turnstile 全局并发 slot
    await limiterStub.fetch('http://internal/release-turnstile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  }
}

/**
 * POST /api/sessions/:sid/telegram - 验证 Telegram OIDC
 */
export async function verifyTelegramToken(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid')!
  const body = await c.req.json<VerifyTelegramRequest>()

  if (!body.nonce || !body.id_token) {
    throw new AppError('INVALID_REQUEST', 'missing nonce or id_token', 400)
  }

  const stub = getSessionStub(c, sessionId)

  // 1. 验证 Telegram ID Token
  const telegramVerifier = new TelegramVerifier(config.telegram.clientId)
  const user = await telegramVerifier.verify(body.id_token, body.nonce)

  // 2. 生成 PoW token
  const powToken = generateSecureToken()

  // 4. 更新会话状态
  const completeResp = await stub.fetch('http://internal/complete-telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce: body.nonce,
      powToken,
      user,
    }),
  })

  if (!completeResp.ok) {
    const error = (await completeResp.json()) as any
    throw new AppError(error.code, error.info.message, completeResp.status)
  }

  const result: VerifyTelegramResponse = {
    pow_token: powToken,
  }

  return c.json(result)
}

/**
 * POST /api/sessions/:id/challenge - 获取 PoW challenge
 */
export async function createChallenge(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid') as string
  const body = await c.req.json<CreateChallengeRequest>()

  if (!body.pow_token) {
    throw new AppError('INVALID_REQUEST', 'missing pow_token', 400)
  }

  // 生成 challenge
  const challenge = generateSecureToken()

  const stub = getSessionStub(c, sessionId)

  // 签发 challenge
  const issueResp = await stub.fetch('http://internal/issue-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      powToken: body.pow_token,
      challenge,
    }),
  })

  if (!issueResp.ok) {
    const error = (await issueResp.json()) as ErrorResponse
    throw new AppError(error.code, error.info.message, issueResp.status)
  }

  const result: CreateChallengeResponse = {
    challenge,
    difficulty: config.pow.difficulty,
    maximum_work: config.pow.maximumWork,
  }

  return c.json(result)
}

/**
 * POST /api/sessions/:id/verify-pow - 验证 PoW 解决方案
 */
export async function verifyPoWHandler(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid') as string
  const body = await c.req.json<VerifyPoWRequest>()

  if (!body.challenge || body.solution === undefined || body.solution === null) {
    throw new AppError('INVALID_REQUEST', 'invalid request', 400)
  }

  // 1. solution 必须落在工作空间内（对齐 Go handler/pow.go:47）
  if (
    !Number.isInteger(body.solution) ||
    body.solution < 0 ||
    body.solution >= config.pow.maximumWork
  ) {
    throw new AppError('POW_SOLUTION_INVALID', 'solution is outside the work space', 422)
  }

  const stub = getSessionStub(c, sessionId)

  // 2. challenge 必须存在且未被消费
  const hasResp = await stub.fetch('http://internal/has-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: body.challenge }),
  })

  const hasResult = await hasResp.json<{ valid: boolean }>()
  if (!hasResult.valid) {
    throw new AppError(
      'STATE_CONFLICT',
      'challenge is missing, expired, or already consumed',
      409
    )
  }

  // 3. 校验 PoW 解
  const valid = await verifyPoW(body.challenge, body.solution, config.pow.difficulty)

  if (!valid) {
    throw new AppError('POW_SOLUTION_INVALID', 'incorrect PoW solution', 422)
  }

  // 4. 消费 challenge 并将会话标记为 verified
  const completeResp = await stub.fetch('http://internal/complete-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: body.challenge }),
  })

  if (!completeResp.ok) {
    throw new AppError('STATE_CONFLICT', 'challenge was already consumed', 409)
  }

  // Go 侧返回 204 No Content
  return c.body(null, 204)
}
