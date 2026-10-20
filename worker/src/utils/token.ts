/**
 * 生成安全的随机 token
 * 对应 Go 版本的 utils/token.go
 */

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const TOKEN_LENGTH = 32

/**
 * 生成 32 字符的加密安全随机 token
 */
export function generateSecureToken(): string {
  const result: string[] = []
  const unbiasedLimit = 256 - (256 % TOKEN_ALPHABET.length)

  while (result.length < TOKEN_LENGTH) {
    const buffer = new Uint8Array(TOKEN_LENGTH)
    crypto.getRandomValues(buffer)

    for (const value of buffer) {
      if (value >= unbiasedLimit) continue
      result.push(TOKEN_ALPHABET[value % TOKEN_ALPHABET.length])
      if (result.length === TOKEN_LENGTH) break
    }
  }

  return result.join('')
}

/**
 * 常量时间字符串比较，防止时序攻击
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false
  }

  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)

  let result = 0
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i]
  }

  return result === 0
}
