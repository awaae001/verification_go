/**
 * Proof-of-Work 验证
 * 对应 Go 版本的 service/pow/verifier.go
 */

/**
 * 验证 PoW 解决方案
 * @param challenge 挑战字符串
 * @param solution 解决方案数字
 * @param difficulty 难度（前导零的十六进制位数）
 * @returns 是否通过验证
 */
export async function verifyPoW(
  challenge: string,
  solution: number,
  difficulty: number
): Promise<boolean> {
  const encoder = new TextEncoder()
  const data = encoder.encode(challenge + solution.toString())

  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)

  // 检查前导零字节
  const fullBytes = Math.floor(difficulty / 2)
  for (let i = 0; i < fullBytes; i++) {
    if (hashArray[i] !== 0) {
      return false
    }
  }

  // 如果难度是奇数，检查下一个字节的高 4 位
  if (difficulty % 2 !== 0) {
    return (hashArray[fullBytes] >> 4) === 0
  }

  return true
}

/**
 * 将字节数组转换为十六进制字符串（用于调试）
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
