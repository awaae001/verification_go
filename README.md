# tg_verification_go

A lightweight HTTP verification service written in Go. It issues verification sessions, challenges clients with Cloudflare Turnstile and a browser proof-of-work puzzle, and verifies Telegram identity via Telegram Login.

Built with [Gin](https://github.com/gin-gonic/gin) and [Viper](https://github.com/spf13/viper).

## Features

- Session-based verification flow with TTL and per-client limits
- Cloudflare Turnstile anti-bot challenge
- SHA-256 proof-of-work puzzle computed in the browser (Web Worker)
- Telegram Login identity verification
- Simple HTML verification page with i18n support
- API key authentication for trusted clients

## Requirements

- Go 1.27+
- A Cloudflare Turnstile site key / secret
- A Telegram bot (for Telegram Login)


## Configuration

Configuration is loaded from `data/system_config.json` (see `src/config/defaults/system_config.json` for the defaults and all available keys), including:

- `turnstile_conf` — Turnstile keys, rate limits, and retry policy
- `telegram_conf` — Telegram client ID
- `pow_conf` — proof-of-work difficulty
- `state_conf` — session TTL, retention, and capacity limits
- `trusted_client_keys` — API keys for trusted clients

## Development

```sh
go test ./...
./scripts/check_flow.sh
```

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
