/**
 * Token 工具测试
 */

import { describe, it, expect } from 'vitest'
import { generateSecureToken, constantTimeEqual } from '../src/utils/token'

describe('Token Utils', () => {
  describe('generateSecureToken', () => {
    it('should generate 32 character token', () => {
      const token = generateSecureToken()
      expect(token).toHaveLength(32)
    })

    it('should generate unique tokens', () => {
      const token1 = generateSecureToken()
      const token2 = generateSecureToken()
      expect(token1).not.toBe(token2)
    })

    it('should only contain valid characters', () => {
      const token = generateSecureToken()
      const validChars = /^[a-zA-Z0-9]+$/
      expect(validChars.test(token)).toBe(true)
    })
  })

  describe('constantTimeEqual', () => {
    it('should return true for equal strings', () => {
      const str = 'test_string_123'
      expect(constantTimeEqual(str, str)).toBe(true)
    })

    it('should return false for different strings', () => {
      expect(constantTimeEqual('abc', 'xyz')).toBe(false)
    })

    it('should return false for different length strings', () => {
      expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    })

    it('should return false for empty strings', () => {
      expect(constantTimeEqual('', '')).toBe(false)
    })

    it('should return false for null/undefined', () => {
      expect(constantTimeEqual(null as any, 'test')).toBe(false)
      expect(constantTimeEqual('test', undefined as any)).toBe(false)
    })
  })
})
