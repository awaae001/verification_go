package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	"tg_verification_go/src/model"
)

func TestJanitorRemovesExpiredPendingSession(t *testing.T) {
	now := time.Now()
	store := newTestStore(1)
	putTestSession(t, store, model.Session{
		ID:        "expired",
		Client:    "client-a",
		Status:    model.SessionStatusPending,
		CreatedAt: now.Add(-2 * time.Second),
		ExpiresAt: now.Add(-time.Second),
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	store.StartJanitor(ctx, time.Millisecond)
	waitForSessionRemoval(t, store, "expired")

	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.sessions) != 0 {
		t.Fatalf("sessions has %d entries, want 0", len(store.sessions))
	}
	if len(store.clientSessions) != 0 {
		t.Fatalf("clientSessions has %d entries, want 0", len(store.clientSessions))
	}
}

func TestCleanupRetainsPendingSessionBeforeExpiry(t *testing.T) {
	now := time.Now()
	store := newTestStore(1)
	putTestSession(t, store, model.Session{
		ID:        "pending",
		Client:    "client-a",
		Status:    model.SessionStatusPending,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Minute),
	})

	removeExpiredAt(store, now)

	if _, exists := store.GetSession("pending", now); !exists {
		t.Fatal("cleanup removed a pending session before its expiration")
	}
}

func TestCleanupRetainsVerifiedSessionBeforeRetention(t *testing.T) {
	verifiedAt := time.Now()
	store := newTestStore(1)
	putVerifiedSession(t, store, "verified", "client-a", verifiedAt)

	removeExpiredAt(store, verifiedAt.Add(store.verifiedRetention-time.Nanosecond))

	if _, exists := store.GetSession("verified", verifiedAt); !exists {
		t.Fatal("cleanup removed a verified session before its retention elapsed")
	}
}

func TestCleanupRemovesVerifiedSessionAtRetention(t *testing.T) {
	verifiedAt := time.Now()
	store := newTestStore(1)
	putVerifiedSession(t, store, "verified", "client-a", verifiedAt)

	removeExpiredAt(store, verifiedAt.Add(store.verifiedRetention))

	if _, exists := store.GetSession("verified", verifiedAt); exists {
		t.Fatal("cleanup retained a verified session after its retention elapsed")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, exists := store.clientSessions["client-a"]; exists {
		t.Fatal("cleanup retained the verified session's client count")
	}
}

func TestPutSessionReclaimsExpiredClientCapacity(t *testing.T) {
	now := time.Now()
	store := newTestStore(1)
	putTestSession(t, store, model.Session{
		ID:        "expired",
		Client:    "client-a",
		Status:    model.SessionStatusPending,
		CreatedAt: now.Add(-2 * time.Minute),
		ExpiresAt: now.Add(-time.Minute),
	})

	err := store.PutSession(model.Session{
		ID:        "replacement",
		Client:    "client-a",
		Status:    model.SessionStatusPending,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Minute),
	})

	if err != nil {
		t.Fatalf("PutSession after expiration: %v", err)
	}
	if _, exists := store.GetSession("replacement", now); !exists {
		t.Fatal("replacement session was not stored")
	}
}

func TestRepeatedCleanupDoesNotAccumulateEntries(t *testing.T) {
	const (
		cycles           = 25
		sessionsPerCycle = 1000
	)
	store := NewStore(StoreConfig{
		TTL:                  time.Minute,
		VerifiedRetention:    time.Minute,
		MaxSessions:          sessionsPerCycle,
		MaxSessionsPerClient: 1,
	})

	for cycle := range cycles {
		createdAt := time.Unix(int64(cycle)*120, 0)
		for index := range sessionsPerCycle {
			identifier := fmt.Sprintf("%d-%d", cycle, index)
			putTestSession(t, store, model.Session{
				ID:        identifier,
				Client:    identifier,
				Status:    model.SessionStatusPending,
				CreatedAt: createdAt,
				ExpiresAt: createdAt.Add(time.Minute),
			})
		}

		removeExpiredAt(store, createdAt.Add(time.Minute))
		if len(store.sessions) != 0 {
			t.Fatalf("cycle %d: sessions has %d entries, want 0", cycle, len(store.sessions))
		}
		if len(store.clientSessions) != 0 {
			t.Fatalf("cycle %d: clientSessions has %d entries, want 0", cycle, len(store.clientSessions))
		}
	}
}

func newTestStore(maxSessionsPerClient int) *Store {
	return NewStore(StoreConfig{
		TTL:                  time.Minute,
		VerifiedRetention:    time.Minute,
		MaxSessions:          10,
		MaxSessionsPerClient: maxSessionsPerClient,
	})
}

func putTestSession(t *testing.T, store *Store, session model.Session) {
	t.Helper()
	if err := store.PutSession(session); err != nil {
		t.Fatalf("PutSession: %v", err)
	}
}

func putVerifiedSession(t *testing.T, store *Store, id, client string, verifiedAt time.Time) {
	t.Helper()
	putTestSession(t, store, model.Session{
		ID:        id,
		Client:    client,
		Status:    model.SessionStatusPending,
		CreatedAt: verifiedAt.Add(-time.Minute),
		ExpiresAt: verifiedAt.Add(time.Minute),
	})
	if _, _, _, ok := store.PassTurnstile(id, "anti-bot-token", "nonce", verifiedAt); !ok {
		t.Fatal("PassTurnstile rejected the test session")
	}
	if ok := store.CompleteTelegram(id, "nonce", "pow-token", model.TelegramUser{}, verifiedAt); !ok {
		t.Fatal("CompleteTelegram rejected the test session")
	}
	if ok := store.IssueChallenge(id, "pow-token", "challenge", verifiedAt); !ok {
		t.Fatal("IssueChallenge rejected the test session")
	}
	if ok := store.CompleteChallenge(id, "challenge", verifiedAt); !ok {
		t.Fatal("CompleteChallenge rejected the test session")
	}
}

func removeExpiredAt(store *Store, now time.Time) {
	store.mu.Lock()
	store.removeExpiredLocked(now)
	store.mu.Unlock()
}

func waitForSessionRemoval(t *testing.T, store *Store, id string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, exists := store.GetSession(id, time.Now()); !exists {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("session %q was not removed before the deadline", id)
}
