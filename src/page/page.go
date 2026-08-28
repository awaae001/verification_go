package page

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"tg_verification_go/src/i18n"
	"tg_verification_go/src/model"
	"tg_verification_go/src/service"

	"github.com/gin-gonic/gin"
)

//go:embed templates/*.html
var templateFS embed.FS

//go:embed static/*
var staticFS embed.FS

type Renderer struct {
	config       *model.Config
	store        *service.Store
	template     *template.Template
	assets       fs.FS
	assetVersion string
	now          func() time.Time
}

// NewRenderer creates the verification page renderer. It panics when the
// embedded templates or assets cannot be read, because that is a build-time
// defect.
func NewRenderer(config *model.Config, stateStore *service.Store) *Renderer {
	assets, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	version, err := assetVersion(assets)
	if err != nil {
		panic(err)
	}
	return &Renderer{
		config:       config,
		store:        stateStore,
		template:     template.Must(template.New("page").Funcs(template.FuncMap{"t": i18n.T}).ParseFS(templateFS, "templates/*.html")),
		assets:       assets,
		assetVersion: version,
		now:          time.Now,
	}
}

// AssetVersion returns the content hash that prefixes every asset URL.
func (r *Renderer) AssetVersion() string {
	return r.assetVersion
}

// Verification renders the browser verification page for a session.
func (r *Renderer) Verification(c *gin.Context) {
	sessionID := c.Param("sid")
	session, exists := r.store.GetSession(sessionID, r.now())
	lang := i18n.Resolve(c.Query("lang"), c.GetHeader("Accept-Language"))

	status := http.StatusOK
	view := model.PageView{State: model.PageStateNotFound, Lang: lang, AssetVersion: r.assetVersion}
	switch {
	case !exists:
		status = http.StatusNotFound
	case session.Status == model.SessionStatusExpired:
		status = http.StatusGone
		view.State = model.PageStateExpired
	case session.Status == model.SessionStatusVerified:
		view.State = model.PageStateDone
	default:
		configJSON, err := json.Marshal(model.PageConfig{
			SessionID:        session.ID,
			TurnstileSiteKey: r.config.Turnstile.SiteKey,
			TurnstileAction:  r.config.Turnstile.Action,
			TelegramClientID: r.config.Telegram.ClientID,
			ExpiresAt:        session.ExpiresAt.Unix(),
			Lang:             lang,
			Messages:         i18n.Messages(lang),
		})
		if err != nil {
			log.Printf("[page][verify] failed to encode page config: %v", err)
			status = http.StatusInternalServerError
			break
		}
		view.State = model.PageStateActive
		view.Config = template.JS(configJSON)
	}

	c.Header("Cache-Control", "no-store")
	c.Status(status)
	c.Header("Content-Type", "text/html; charset=utf-8")
	if err := r.template.ExecuteTemplate(c.Writer, "verify.html", view); err != nil {
		log.Printf("[page][verify] failed to render page: %v", err)
	}
}

// Privacy renders the privacy policy page.
func (r *Renderer) Privacy(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Type", "text/html; charset=utf-8")
	if err := r.template.ExecuteTemplate(c.Writer, "privacy.html", model.PageView{AssetVersion: r.assetVersion}); err != nil {
		log.Printf("[page][privacy] failed to render page: %v", err)
	}
}

// Static serves the embedded page assets under their content-hashed prefix.
//
// Only the prefix of the running build is served: every other path is a stale
// URL from an older build, and answering it would let an intermediate cache mix
// asset versions.
func (r *Renderer) Static() gin.HandlerFunc {
	prefix := "/static/" + r.assetVersion + "/"
	server := http.StripPrefix(prefix, http.FileServer(http.FS(r.assets)))
	return func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, prefix) {
			c.Status(http.StatusNotFound)
			return
		}
		// Safe to pin forever: a changed asset changes the prefix.
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
		server.ServeHTTP(c.Writer, c.Request)
	}
}

// assetVersion hashes every asset name and its content into a short, stable
// version string. fs.WalkDir visits entries in lexical order, so the result
// depends only on the asset contents.
func assetVersion(assets fs.FS) (string, error) {
	digest := sha256.New()
	err := fs.WalkDir(assets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		file, err := assets.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		if _, err := digest.Write([]byte(path + "\x00")); err != nil {
			return err
		}
		_, err = io.Copy(digest, file)
		return err
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil))[:12], nil
}
