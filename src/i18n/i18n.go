package i18n

import (
	"strconv"
	"strings"
)

// Supported page languages. They double as the accepted values of the ?lang=
// override.
const (
	English = "en"
	Chinese = "zh"
)

// Resolve picks the page language from the explicit lang query parameter, then
// from the Accept-Language header weighted by q-values, defaulting to English.
func Resolve(query, acceptLanguage string) string {
	switch query {
	case English, Chinese:
		return query
	}
	best := ""
	bestQuality := -1.0
	for _, part := range strings.Split(acceptLanguage, ",") {
		tag, params, _ := strings.Cut(part, ";")
		tag = strings.ToLower(strings.TrimSpace(tag))
		lang := ""
		switch {
		case strings.HasPrefix(tag, Chinese):
			lang = Chinese
		case strings.HasPrefix(tag, English):
			lang = English
		default:
			continue
		}
		quality := 1.0
		for _, param := range strings.Split(params, ";") {
			value, ok := strings.CutPrefix(strings.TrimSpace(param), "q=")
			if !ok {
				continue
			}
			if parsed, err := strconv.ParseFloat(value, 64); err == nil {
				quality = parsed
			}
		}
		if quality > bestQuality {
			best, bestQuality = lang, quality
		}
	}
	if best == "" {
		return English
	}
	return best
}

// T returns the message for key in lang, falling back to English and finally
// to the key itself so a missing translation never renders as an empty page.
func T(lang, key string) string {
	if table, ok := tables[lang]; ok {
		if message, ok := table[key]; ok {
			return message
		}
	}
	if message, ok := tables[English][key]; ok {
		return message
	}
	return key
}

// Messages returns the full message table for lang merged over English, ready
// to be handed to the client-side script as part of the page config.
func Messages(lang string) map[string]string {
	merged := make(map[string]string, len(tables[English]))
	for key, message := range tables[English] {
		merged[key] = message
	}
	for key, message := range tables[lang] {
		merged[key] = message
	}
	return merged
}

var tables = map[string]map[string]string{
	English: {
		"title":             "Human Verification",
		"subtitle.active":   "Follow the on-screen prompts. This takes less than a minute.",
		"subtitle.done":     "This verification is already complete.",
		"subtitle.expired":  "This verification link has expired.",
		"subtitle.notfound": "This verification link is not valid.",

		"stage.turnstile.title": "Verify you're not a robot",
		"stage.turnstile.hint":  "Complete the quick check below to continue.",
		"stage.telegram.title":  "Connect your account",
		"stage.telegram.hint":   "Sign in with Telegram so we can link this verification to you. It is used for this session only.",
		"stage.telegram.button": "Log in with Telegram",
		"stage.confirm.title":   "We're confirming",
		"stage.confirm.hint":    "Sit tight while we finish your verification. Keep this page open.",
		"confirm.progress.aria": "Confirmation progress",

		"status.loading":    "Loading the security check.",
		"outcome.retry":     "Try again",
		"outcome.error":     "Something went wrong",
		"outcome.sessionid": "Session ID:",
		"state.done":        "Verification complete. You can close this page and confirm in the bot.",
		"state.expired":     "Ask the bot for a new verification link.",
		"state.notfound":    "Ask the bot for a new verification link.",
		"footer.privacy":    "Privacy & Terms",

		"terminal.SESSION_NOT_FOUND":        "This verification session no longer exists. Ask the bot for a new link.",
		"terminal.SESSION_EXPIRED":          "This verification session has expired. Ask the bot for a new link.",
		"terminal.ANTIBOT_REQUIRED":         "This verification session is no longer valid. Ask the bot for a new link.",
		"terminal.STATE_CONFLICT":           "This verification session is no longer valid. Ask the bot for a new link.",
		"terminal.TURNSTILE_UNAVAILABLE":    "The anti-bot service is unavailable. Please try again later.",
		"terminal.TELEGRAM_KEY_UNAVAILABLE": "Telegram verification is unavailable. Please try again later.",
		"terminal.INTERNAL_ERROR":           "The verification service failed. Please try again later.",

		"status.stopped":             "Verification stopped.",
		"status.failed":              "Verification failed.",
		"status.turnstile_waiting":   "Complete the quick check to continue.",
		"status.checking":            "Checking…",
		"status.telegram_preparing":  "Preparing a secure connection…",
		"status.telegram_ready":      "Sign in with Telegram to continue.",
		"status.telegram_connecting": "Connecting your account…",
		"status.confirming":          "We're confirming your verification…",
		"status.pow":                 "Confirming — this can take a moment. Keep this page open.",
		"status.submitting":          "Almost done…",
		"status.complete":            "Verification complete.",
		"outcome.success":            "Verification complete. Return to the bot and confirm.",
		"error.turnstile_failed":     "The anti-bot check could not be completed.",
		"error.turnstile_rate":       "Too many attempts. Wait a moment and try again.",
		"error.turnstile_script":     "The anti-bot script could not be loaded.",
		"error.telegram_unavailable": "Telegram login is not available in this browser. Please reopen the verification link in Telegram.",
		"error.telegram_timeout":     "Telegram did not finish signing in. Please try again.",
		"error.telegram_cancelled":   "Telegram login was cancelled. Please try again.",
		"error.unsupported_browser":  "This browser cannot produce the required local audio or visual profile.",
		"error.fingerprint":          "The device profile could not be computed.",
		"error.pow":                  "The proof of work failed.",
		"error.pow_worker":           "The proof-of-work worker could not run.",
	},
	Chinese: {
		"title":             "人机验证",
		"subtitle.active":   "按照页面提示操作即可，全程不到一分钟。",
		"subtitle.done":     "此验证已完成。",
		"subtitle.expired":  "此验证链接已过期。",
		"subtitle.notfound": "此验证链接无效。",

		"stage.turnstile.title": "验证您不是机器人",
		"stage.turnstile.hint":  "完成下方的快速验证以继续。",
		"stage.telegram.title":  "连接您的账户",
		"stage.telegram.hint":   "使用 Telegram 登录，以便将本次验证与您关联。仅用于本次会话。",
		"stage.telegram.button": "使用 Telegram 登录",
		"stage.confirm.title":   "我们正在确认",
		"stage.confirm.hint":    "请稍候，我们正在完成您的验证。请勿关闭此页面。",
		"confirm.progress.aria": "确认进度",

		"status.loading":    "正在加载安全验证。",
		"outcome.retry":     "重试",
		"outcome.error":     "验证发生错误",
		"outcome.sessionid": "会话 ID：",
		"state.done":        "验证完成。您可以关闭此页面，并回到机器人处确认。",
		"state.expired":     "请向机器人索取新的验证链接。",
		"state.notfound":    "请向机器人索取新的验证链接。",
		"footer.privacy":    "隐私与条款",

		"terminal.SESSION_NOT_FOUND":        "此验证会话已不存在。请向机器人索取新的链接。",
		"terminal.SESSION_EXPIRED":          "此验证会话已过期。请向机器人索取新的链接。",
		"terminal.ANTIBOT_REQUIRED":         "此验证会话已失效。请向机器人索取新的链接。",
		"terminal.STATE_CONFLICT":           "此验证会话已失效。请向机器人索取新的链接。",
		"terminal.TURNSTILE_UNAVAILABLE":    "反机器人服务暂不可用，请稍后重试。",
		"terminal.TELEGRAM_KEY_UNAVAILABLE": "Telegram 验证暂不可用，请稍后重试。",
		"terminal.INTERNAL_ERROR":           "验证服务出现故障，请稍后重试。",

		"status.stopped":             "验证已停止。",
		"status.failed":              "验证失败。",
		"status.turnstile_waiting":   "完成快速验证以继续。",
		"status.checking":            "正在检查…",
		"status.telegram_preparing":  "正在建立安全连接…",
		"status.telegram_ready":      "使用 Telegram 登录以继续。",
		"status.telegram_connecting": "正在连接您的账户…",
		"status.confirming":          "我们正在确认您的验证…",
		"status.pow":                 "正在确认——可能需要片刻。请勿关闭此页面。",
		"status.submitting":          "即将完成…",
		"status.complete":            "验证完成。",
		"outcome.success":            "验证完成。请回到机器人处确认。",
		"error.turnstile_failed":     "无法完成反机器人验证。",
		"error.turnstile_rate":       "尝试过于频繁，请稍候再试。",
		"error.turnstile_script":     "无法加载反机器人验证脚本。",
		"error.telegram_unavailable": "当前浏览器无法使用 Telegram 登录。请在 Telegram 中重新打开验证链接。",
		"error.telegram_timeout":     "Telegram 登录未能完成，请重试。",
		"error.telegram_cancelled":   "已取消 Telegram 登录，请重试。",
		"error.unsupported_browser":  "当前浏览器无法生成所需的本地音频或图像特征。",
		"error.fingerprint":          "无法计算设备特征。",
		"error.pow":                  "工作量证明失败。",
		"error.pow_worker":           "无法运行工作量证明组件。",
	},
}
