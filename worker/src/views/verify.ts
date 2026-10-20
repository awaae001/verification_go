/**
 * 验证页面渲染
 * 对应 Go 版本的 templates
 */

import type { Context } from 'hono'
import { html } from 'hono/html'
import type { Env, Config, Variables } from '../types/env'

export function renderVerifyPage(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  sessionId: string,
  config: Config
) {
  return c.html(html`
    <!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Telegram 用户验证</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          async
          defer
        ></script>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
              'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }

          .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 480px;
            width: 100%;
            padding: 40px;
          }

          h1 {
            font-size: 28px;
            font-weight: 700;
            color: #2c3e50;
            margin-bottom: 12px;
            text-align: center;
          }

          .subtitle {
            font-size: 14px;
            color: #7f8c8d;
            text-align: center;
            margin-bottom: 32px;
          }

          .step {
            display: none;
            animation: fadeIn 0.3s ease-in;
          }

          .step.active {
            display: block;
          }

          @keyframes fadeIn {
            from {
              opacity: 0;
              transform: translateY(10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          .step-indicator {
            display: flex;
            justify-content: center;
            margin-bottom: 32px;
            gap: 12px;
          }

          .indicator-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #e0e0e0;
            transition: all 0.3s;
          }

          .indicator-dot.active {
            background: #667eea;
            transform: scale(1.2);
          }

          .turnstile-container {
            display: flex;
            justify-content: center;
            margin: 24px 0;
          }

          .telegram-login-btn {
            display: inline-block;
            width: 100%;
            padding: 16px;
            background: #0088cc;
            color: white;
            text-align: center;
            text-decoration: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            transition: background 0.3s;
            cursor: pointer;
            border: none;
          }

          .telegram-login-btn:hover {
            background: #006ba1;
          }

          .telegram-login-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
          }

          .pow-container {
            text-align: center;
          }

          .progress-bar {
            width: 100%;
            height: 8px;
            background: #e0e0e0;
            border-radius: 4px;
            overflow: hidden;
            margin: 16px 0;
          }

          .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            transition: width 0.3s;
          }

          .status {
            font-size: 14px;
            color: #7f8c8d;
            margin-top: 12px;
          }

          .success-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 24px;
            border-radius: 50%;
            background: #2ecc71;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 48px;
          }

          .error {
            background: #e74c3c;
            color: white;
            padding: 12px;
            border-radius: 8px;
            margin-top: 16px;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🔐 用户验证</h1>
          <p class="subtitle">请完成以下验证步骤</p>

          <div class="step-indicator">
            <div class="indicator-dot active" data-step="1"></div>
            <div class="indicator-dot" data-step="2"></div>
            <div class="indicator-dot" data-step="3"></div>
          </div>

          <!-- Step 1: Turnstile -->
          <div class="step active" id="step-turnstile">
            <h2 style="margin-bottom: 16px; font-size: 18px; text-align: center;">
              第 1 步：人机验证
            </h2>
            <div class="turnstile-container">
              <div
                class="cf-turnstile"
                data-sitekey="${config.turnstile.siteKey}"
                data-callback="onTurnstileSuccess"
                data-error-callback="onTurnstileError"
              ></div>
            </div>
          </div>

          <!-- Step 2: Telegram Login -->
          <div class="step" id="step-telegram">
            <h2 style="margin-bottom: 16px; font-size: 18px; text-align: center;">
              第 2 步：Telegram 登录
            </h2>
            <button
              class="telegram-login-btn"
              id="telegram-login"
              onclick="loginTelegram()"
            >
              🚀 使用 Telegram 登录
            </button>
          </div>

          <!-- Step 3: PoW Challenge -->
          <div class="step" id="step-pow">
            <h2 style="margin-bottom: 16px; font-size: 18px; text-align: center;">
              第 3 步：计算验证
            </h2>
            <div class="pow-container">
              <div class="progress-bar">
                <div class="progress-fill" id="pow-progress" style="width: 0%"></div>
              </div>
              <div class="status" id="pow-status">正在计算...</div>
            </div>
          </div>

          <!-- Success -->
          <div class="step" id="step-success">
            <div class="success-icon">✓</div>
            <h2 style="text-align: center; color: #2ecc71; margin-bottom: 12px;">
              验证成功！
            </h2>
            <p style="text-align: center; color: #7f8c8d;">
              您可以关闭此页面
            </p>
          </div>

          <div id="error-container"></div>
        </div>

        <script>
          const SESSION_ID = '${sessionId}'
          const BASE_URL = window.location.origin

          let antiBotToken = ''
          let nonce = ''
          let powToken = ''

          // Step 1: Turnstile Success
          function onTurnstileSuccess(token) {
            fetch(\`\${BASE_URL}/api/sessions/\${SESSION_ID}/antibot\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            })
              .then((res) => {
                if (!res.ok) throw new Error('Turnstile verification failed')
                return res.json()
              })
              .then((data) => {
                antiBotToken = data.antibot_token
                nonce = data.nonce
                showStep(2)
              })
              .catch(showError)
          }

          function onTurnstileError() {
            showError(new Error('Turnstile widget error'))
          }

          // Step 2: Telegram Login
          function loginTelegram() {
            const authUrl = \`https://oauth.telegram.org/auth?bot_id=${config.telegram.clientId}&origin=\${encodeURIComponent(window.location.origin)}&request_access=write&return_to=\${encodeURIComponent(window.location.href)}\`
            
            // 使用 Telegram Mini App SDK（如果可用）
            if (window.Telegram?.WebApp) {
              window.Telegram.WebApp.openTelegramLink(authUrl)
            } else {
              window.location.href = authUrl
            }
          }

          // 处理 Telegram 回调
          window.addEventListener('load', () => {
            const params = new URLSearchParams(window.location.search)
            const idToken = params.get('tgAuthResult')
            
            if (idToken && nonce) {
              // 验证 Telegram token
              fetch(\`\${BASE_URL}/api/sessions/\${SESSION_ID}/telegram\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nonce, id_token: idToken }),
              })
                .then((res) => {
                  if (!res.ok) throw new Error('Telegram verification failed')
                  return res.json()
                })
                .then((data) => {
                  powToken = data.pow_token
                  showStep(3)
                  startPoW()
                })
                .catch(showError)
            }
          })

          // Step 3: PoW Challenge
          async function startPoW() {
            try {
              // 获取 challenge
              const challengeRes = await fetch(
                \`\${BASE_URL}/api/sessions/\${SESSION_ID}/challenge\`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ pow_token: powToken }),
                }
              )
              const challengeData = await challengeRes.json()

              // 计算 PoW
              const solution = await solvePoW(
                challengeData.challenge,
                challengeData.difficulty,
                challengeData.maximum_work
              )

              // 提交解决方案
              const verifyRes = await fetch(
                \`\${BASE_URL}/api/sessions/\${SESSION_ID}/pow\`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    challenge: challengeData.challenge,
                    solution,
                  }),
                }
              )

              if (!verifyRes.ok) throw new Error('PoW verification failed')

              showStep(4)
            } catch (err) {
              showError(err)
            }
          }

          async function solvePoW(challenge, difficulty, maxWork) {
            const encoder = new TextEncoder()
            const difficultyInt = parseInt(difficulty)

            for (let solution = 0; solution < maxWork; solution++) {
              if (solution % 10000 === 0) {
                const progress = Math.min((solution / maxWork) * 100, 100)
                document.getElementById('pow-progress').style.width = progress + '%'
                document.getElementById('pow-status').textContent =
                  \`已尝试 \${solution.toLocaleString()} 次...\`
                await new Promise((r) => setTimeout(r, 0))
              }

              const data = encoder.encode(challenge + solution)
              const hashBuffer = await crypto.subtle.digest('SHA-256', data)
              const hashArray = new Uint8Array(hashBuffer)

              if (checkDifficulty(hashArray, difficultyInt)) {
                document.getElementById('pow-progress').style.width = '100%'
                return solution
              }
            }

            throw new Error('PoW max work exceeded')
          }

          function checkDifficulty(hash, difficulty) {
            const fullBytes = Math.floor(difficulty / 2)
            for (let i = 0; i < fullBytes; i++) {
              if (hash[i] !== 0) return false
            }
            if (difficulty % 2 !== 0) {
              return (hash[fullBytes] >> 4) === 0
            }
            return true
          }

          function showStep(step) {
            document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'))
            document.querySelectorAll('.indicator-dot').forEach((el) => el.classList.remove('active'))
            
            if (step === 2) {
              document.getElementById('step-telegram').classList.add('active')
              document.querySelector('[data-step="2"]').classList.add('active')
            } else if (step === 3) {
              document.getElementById('step-pow').classList.add('active')
              document.querySelector('[data-step="3"]').classList.add('active')
            } else if (step === 4) {
              document.getElementById('step-success').classList.add('active')
            }
          }

          function showError(err) {
            const container = document.getElementById('error-container')
            container.innerHTML = \`<div class="error">\${err.message}</div>\`
          }
        </script>
      </body>
    </html>
  `)
}
