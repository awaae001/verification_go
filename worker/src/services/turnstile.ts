/**
 * Cloudflare Turnstile 验证服务
 * 对应 Go 版本的 service/turnstile.go
 */

import type { TurnstileVerifyResponse } from '../types/models'
import { AppError } from '../types/models'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export interface TurnstileConfig {
  secret: string
  action: string
}

export class TurnstileService {
  constructor(private config: TurnstileConfig) {}

  /**
   * 验证 Turnstile token
   */
  async verify(token: string, expectedHostname: string): Promise<void> {
    const formData = new URLSearchParams()
    formData.append('secret', this.config.secret)
    formData.append('response', token)

    let response: Response
    try {
      response = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      })
    } catch (err) {
      console.error('[turnstile] siteverify request failed:', err)
      throw new AppError(
        'TURNSTILE_UNAVAILABLE',
        'turnstile verification service unavailable',
        503
      )
    }

    if (!response.ok) {
      console.error('[turnstile] siteverify returned status:', response.status)
      throw new AppError(
        'TURNSTILE_UNAVAILABLE',
        'turnstile verification service unavailable',
        503
      )
    }

    let result: TurnstileVerifyResponse
    try {
      result = await response.json()
    } catch (err) {
      console.error('[turnstile] failed to parse siteverify response:', err)
      throw new AppError(
        'TURNSTILE_UNAVAILABLE',
        'turnstile verification service unavailable',
        503
      )
    }

    if (!result.success) {
      console.error('[turnstile] verification failed:', result['error-codes'])
      throw new AppError('TURNSTILE_FAILED', 'turnstile verification failed', 403, {
        errors: result['error-codes'],
      })
    }

    // 验证 hostname（不区分大小写）
    if (
      result.hostname &&
      result.hostname.toLowerCase() !== expectedHostname.toLowerCase()
    ) {
      console.error('[turnstile] hostname mismatch:', {
        expected: expectedHostname,
        actual: result.hostname,
      })
      throw new AppError('TURNSTILE_FAILED', 'turnstile verification failed', 403, {
        reason: 'hostname mismatch',
      })
    }

    // 验证 action
    if (result.action && result.action !== this.config.action) {
      console.error('[turnstile] action mismatch:', {
        expected: this.config.action,
        actual: result.action,
      })
      throw new AppError('TURNSTILE_FAILED', 'turnstile verification failed', 403, {
        reason: 'action mismatch',
      })
    }
  }
}

/**
 * 从请求中提取 hostname
 */
export function getRequestHostname(request: Request): string {
  const url = new URL(request.url)
  return url.hostname
}
