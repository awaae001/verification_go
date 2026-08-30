#!/usr/bin/env node

/**
 * 生成客户端密钥工具
 * 用于生成 TRUSTED_CLIENT_KEYS
 */

const crypto = require('crypto')

function generateKey() {
  return crypto.randomBytes(32).toString('base64')
}

function main() {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    console.log('用法: node generate-keys.js <client_name> [client_name2] ...')
    console.log('\n示例:')
    console.log('  node generate-keys.js tg_bot')
    console.log('  node generate-keys.js tg_bot admin_panel')
    process.exit(1)
  }

  console.log('🔑 生成客户端密钥...\n')

  const pairs = []
  for (const clientName of args) {
    const key = generateKey()
    pairs.push(`${clientName}=${key}`)
    console.log(`客户端: ${clientName}`)
    console.log(`密钥:   ${key}`)
    console.log()
  }

  console.log('=' .repeat(60))
  console.log('\nTRUSTED_CLIENT_KEYS 格式（复制以下内容）:')
  console.log()
  console.log(pairs.join(','))
  console.log()
  console.log('=' .repeat(60))
  console.log('\n设置 Secret:')
  console.log('  wrangler secret put TRUSTED_CLIENT_KEYS')
  console.log('  然后粘贴上面的字符串')
}

main()
