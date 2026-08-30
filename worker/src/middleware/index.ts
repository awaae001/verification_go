/**
 * Hono 中间件
 * 对应 Go 版本的 middleware
 */

import type { Context, Next } from 'hono'
import type { Env, Config } from '../types/env'
import { AppError } from '../types/models'
import { constantTimeEqual } from '../utils/token'

/**
 * 客户端认证中间件
 * 验证 X-Client-Key header
 */
export function clientAuth(config: Config) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const clientKey = c.req.header('X-Client-Key')
    const clientName = c.req.header('X-Client-Name')

    if (!clientKey || !clientName) {
      throw new AppError('UNAUTHORIZED', 'missing client credentials', 401)
    }

    // 验证客户端密钥
    const expectedKey = config.trustedClients.get(clientName)
    if (!expectedKey) {
      console.error('[auth] unknown client:', clientName)
      throw new AppError('UNAUTHORIZED', 'invalid client', 401)
    }

    if (!constantTimeEqual(clientKey, expectedKey)) {
      console.error('[auth] invalid key for client:', clientName)
      throw new AppError('UNAUTHORIZED', 'invalid client credentials', 401)
    }

    // 将客户端名称存储到上下文
    c.set('client', clientName)

    await next()
  }
}

/**
 * CORS 中间件
 */
export function cors() {
  return async (c: Context, next: Next) => {
    // 处理预检请求
    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Client-Key, X-Client-Name',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    await next()

    // 添加 CORS headers
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type, X-Client-Key, X-Client-Name')
  }
}

/**
 * 错误处理中间件
 */
export function errorHandler() {
  return async (c: Context, next: Next) => {
    try {
      await next()
    } catch (err) {
      if (err instanceof AppError) {
        return c.json(
          {
            code: err.code,
            info: {
              message: err.message,
              ...err.info,
            },
          },
          err.status
        )
      }

      console.error('[error] unhandled error:', err)
      return c.json(
        {
          code: 'INTERNAL_ERROR',
          info: {
            message: 'internal server error',
          },
        },
        500
      )
    }
  }
}

/**
 * 请求日志中间件
 */
export function logger() {
  return async (c: Context, next: Next) => {
    const start = Date.now()
    const method = c.req.method
    const path = c.req.path

    await next()

    const duration = Date.now() - start
    const status = c.res.status

    console.log(`[${method}] ${path} ${status} ${duration}ms`)
  }
}
