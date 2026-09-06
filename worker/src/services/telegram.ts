/**
 * Telegram OIDC ID Token 验证服务
 * 对应 Go 版本的 service/telegram/verifier.go
 */

import { jwtVerify, createRemoteJWKSet, type JWTVerifyResult } from 'jose'
import type { TelegramUser, TelegramTokenClaims } from '../types/models'
import { AppError } from '../types/models'

const TELEGRAM_ISSUER = 'https://oauth.telegram.org'
const TELEGRAM_JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json'

export class TelegramVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(private clientId: string) {
    this.jwks = createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL))
  }

  /**
   * 验证 Telegram ID Token
   * @param idToken JWT token
   * @param expectedNonce 预期的 nonce
   * @returns 验证通过的 Telegram 用户信息
   */
  async verify(idToken: string, expectedNonce: string): Promise<TelegramUser> {
    let result: JWTVerifyResult
    try {
      result = await jwtVerify(idToken, this.jwks, {
        issuer: TELEGRAM_ISSUER,
        audience: this.clientId,
        algorithms: ['RS256', 'ES256', 'EdDSA'],
      })
    } catch (err) {
      console.error('[telegram] JWT verification failed:', err)
      throw new AppError(
        'TELEGRAM_TOKEN_INVALID',
        'invalid Telegram ID token',
        401,
        { reason: err instanceof Error ? err.message : 'verification failed' }
      )
    }

    const claims = result.payload as unknown as TelegramTokenClaims

    // 验证必要的 claims
    if (!claims.sub) {
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'token subject is missing', 401)
    }

    // 对齐 Go verifier.go:109-117: 显式校验 iat/exp 时间范围
    // jose 的 jwtVerify 默认校验 exp，但不校验 iat（未来签发攻击防护）
    const now = Math.floor(Date.now() / 1000)
    const iat = typeof claims.iat === 'number' ? claims.iat : 0
    const exp = typeof claims.exp === 'number' ? claims.exp : 0

    if (iat >= exp) {
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'invalid token time range', 401)
    }
    if (iat > now) {
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'token was issued in the future', 401)
    }
    if (exp <= now) {
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'token is expired', 401)
    }

    if (!claims.nonce) {
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'token nonce is missing', 401)
    }

    if (claims.nonce !== expectedNonce) {
      console.error('[telegram] nonce mismatch:', {
        expected: expectedNonce,
        actual: claims.nonce,
      })
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'invalid token nonce', 401)
    }

    // 解析用户 ID（可能是字符串或数字）
    let userId: number
    if (typeof claims.id === 'number') {
      userId = claims.id
    } else if (typeof claims.id === 'string') {
      userId = parseInt(claims.id, 10)
      if (isNaN(userId)) {
        throw new AppError('TELEGRAM_TOKEN_INVALID', 'invalid user ID format', 401)
      }
    } else {
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'user ID is missing', 401)
    }

    if (!claims.name) {
      throw new AppError('TELEGRAM_TOKEN_INVALID', 'user name is missing', 401)
    }

    return {
      id: userId,
      name: claims.name,
    }
  }
}
