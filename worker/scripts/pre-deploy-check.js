#!/usr/bin/env node

/**
 * 部署前检查脚本
 * 验证配置是否完整
 */

const fs = require('fs')
const path = require('path')

console.log('🔍 开始部署前检查...\n')

let hasErrors = false

// 检查 wrangler.toml
const wranglerPath = path.join(__dirname, '..', 'wrangler.toml')
if (!fs.existsSync(wranglerPath)) {
  console.error('❌ wrangler.toml 不存在')
  hasErrors = true
} else {
  const content = fs.readFileSync(wranglerPath, 'utf8')
  
  // 检查必要的配置项
  const requiredVars = [
    'TELEGRAM_CLIENT_ID',
    'BASE_URL',
    'TURNSTILE_SITE_KEY',
  ]
  
  for (const varName of requiredVars) {
    if (!content.includes(varName)) {
      console.error(`❌ wrangler.toml 缺少配置: ${varName}`)
      hasErrors = true
    }
  }
  
  // 检查是否有占位符
  if (content.includes('your_') || content.includes('example.com')) {
    console.warn('⚠️  wrangler.toml 包含占位符，请替换为实际值')
  }
  
  console.log('✅ wrangler.toml 检查通过')
}

// 检查 package.json
const packagePath = path.join(__dirname, '..', 'package.json')
if (!fs.existsSync(packagePath)) {
  console.error('❌ package.json 不存在')
  hasErrors = true
} else {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  
  const requiredDeps = ['hono', 'jose']
  for (const dep of requiredDeps) {
    if (!pkg.dependencies || !pkg.dependencies[dep]) {
      console.error(`❌ 缺少依赖: ${dep}`)
      hasErrors = true
    }
  }
  
  console.log('✅ package.json 检查通过')
}

// 检查 TypeScript 配置
const tsconfigPath = path.join(__dirname, '..', 'tsconfig.json')
if (!fs.existsSync(tsconfigPath)) {
  console.error('❌ tsconfig.json 不存在')
  hasErrors = true
} else {
  console.log('✅ tsconfig.json 检查通过')
}

// 检查核心文件
const requiredFiles = [
  'src/index.ts',
  'src/durable-objects/session-store.ts',
  'src/handlers/sessions.ts',
  'src/middleware/index.ts',
]

for (const file of requiredFiles) {
  const filePath = path.join(__dirname, '..', file)
  if (!fs.existsSync(filePath)) {
    console.error(`❌ 核心文件缺失: ${file}`)
    hasErrors = true
  }
}

if (requiredFiles.every(f => fs.existsSync(path.join(__dirname, '..', f)))) {
  console.log('✅ 核心文件检查通过')
}

// 检查 node_modules
const nodeModulesPath = path.join(__dirname, '..', 'node_modules')
if (!fs.existsSync(nodeModulesPath)) {
  console.warn('⚠️  node_modules 不存在，请运行: npm install')
}

// 提示 Secrets
console.log('\n📝 部署前请确保已设置 Secrets:')
console.log('   wrangler secret put TURNSTILE_SECRET')
console.log('   wrangler secret put API_KEY')
console.log('   wrangler secret put TRUSTED_CLIENT_KEYS')

// 总结
console.log('\n' + '='.repeat(50))
if (hasErrors) {
  console.error('❌ 检查失败，请修复以上问题后再部署')
  process.exit(1)
} else {
  console.log('✅ 所有检查通过，可以部署！')
  console.log('\n运行以下命令部署:')
  console.log('   npm run deploy')
  process.exit(0)
}
