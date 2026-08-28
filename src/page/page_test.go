package page

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tg_verification_go/src/model"
	"tg_verification_go/src/service"

	"github.com/gin-gonic/gin"
)

func newTestRenderer(t *testing.T) (*Renderer, *service.Store) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store := service.NewStore(10*time.Minute, time.Hour)
	config := &model.Config{}
	config.Turnstile.SiteKey = "0xSITEKEY"
	config.Turnstile.Action = "verification"
	config.Telegram.ClientID = "1234567890"
	return NewRenderer(config, store), store
}

func newTestEngine(t *testing.T, renderer *Renderer) *gin.Engine {
	t.Helper()
	engine := gin.New()
	engine.GET("/v/:sid", renderer.Verification)
	engine.GET("/static/*filepath", renderer.Static())
	return engine
}

func TestPageReferencesVersionedAssets(t *testing.T) {
	renderer, store := newTestRenderer(t)
	engine := newTestEngine(t, renderer)
	now := time.Now()
	store.PutSession(model.Session{
		ID:        "session",
		Status:    model.SessionStatusPending,
		CreatedAt: now,
		ExpiresAt: now.Add(10 * time.Minute),
	})

	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v/session", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("got status %d, want %d", recorder.Code, http.StatusOK)
	}

	body := recorder.Body.String()
	for _, asset := range []string{"app.css", "app.js"} {
		want := "/static/" + renderer.AssetVersion() + "/" + asset
		if !strings.Contains(body, want) {
			t.Fatalf("page does not reference %s", want)
		}
	}
	if strings.Contains(body, `"/static/app.`) {
		t.Fatal("page still references an unversioned asset URL")
	}
}

func TestVerificationPageRendersChinese(t *testing.T) {
	renderer, store := newTestRenderer(t)
	engine := newTestEngine(t, renderer)
	now := time.Now()
	store.PutSession(model.Session{
		ID:        "session",
		Status:    model.SessionStatusPending,
		CreatedAt: now,
		ExpiresAt: now.Add(10 * time.Minute),
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v/session", nil)
	request.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	engine.ServeHTTP(recorder, request)

	body := recorder.Body.String()
	if !strings.Contains(body, `<html lang="zh">`) {
		t.Fatal("page does not declare lang=zh")
	}
	if !strings.Contains(body, "人机验证") {
		t.Fatal("page does not render the Chinese title")
	}
	if strings.Contains(body, "Human Verification") {
		t.Fatal("page still renders the English title")
	}
}

func TestVerificationPageHonorsLangQuery(t *testing.T) {
	renderer, store := newTestRenderer(t)
	engine := newTestEngine(t, renderer)
	now := time.Now()
	store.PutSession(model.Session{
		ID:        "session",
		Status:    model.SessionStatusPending,
		CreatedAt: now,
		ExpiresAt: now.Add(10 * time.Minute),
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v/session?lang=en", nil)
	request.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	engine.ServeHTTP(recorder, request)

	body := recorder.Body.String()
	if !strings.Contains(body, `<html lang="en">`) {
		t.Fatal("page does not declare lang=en")
	}
	if !strings.Contains(body, "Human Verification") {
		t.Fatal("page does not render the English title")
	}
}

func TestServeVersionedAssets(t *testing.T) {
	renderer, _ := newTestRenderer(t)
	engine := newTestEngine(t, renderer)
	version := renderer.AssetVersion()

	tests := []struct {
		name       string
		path       string
		wantStatus int
	}{
		{"current version", "/static/" + version + "/app.js", http.StatusOK},
		{"stale version", "/static/000000000000/app.js", http.StatusNotFound},
		{"unversioned", "/static/app.js", http.StatusNotFound},
		{"missing asset", "/static/" + version + "/missing.js", http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, test.path, nil))
			if recorder.Code != test.wantStatus {
				t.Fatalf("got status %d, want %d", recorder.Code, test.wantStatus)
			}
		})
	}
}

func TestVersionedAssetsAreImmutable(t *testing.T) {
	renderer, _ := newTestRenderer(t)
	engine := newTestEngine(t, renderer)

	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/static/"+renderer.AssetVersion()+"/app.css", nil))
	if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("got Cache-Control %q", got)
	}
}

func TestAssetVersionIsStable(t *testing.T) {
	first, _ := newTestRenderer(t)
	second, _ := newTestRenderer(t)
	if first.AssetVersion() != second.AssetVersion() {
		t.Fatalf("asset version is not stable: %q != %q", first.AssetVersion(), second.AssetVersion())
	}
	if len(first.AssetVersion()) != 12 {
		t.Fatalf("got asset version %q, want 12 characters", first.AssetVersion())
	}
}
