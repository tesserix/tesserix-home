// Package audit writes the tamper-evident record of who touched which secret.
// It records that an action happened and against what path — never the value.
package audit

import (
	"encoding/json"
	"io"
	"sync"
	"time"
)

type Action string

const (
	ActionLogin       Action = "auth.login"
	ActionLogout      Action = "auth.logout"
	ActionLoginDenied Action = "auth.login_denied"
	ActionSecretList  Action = "secret.list"
	// A secret's shape can be described; its values can never be read, so there
	// is deliberately no secret.read action to record.
	ActionSecretDescribe Action = "secret.describe"
	ActionSecretWrite    Action = "secret.write"
	ActionSecretDelete   Action = "secret.delete"
	ActionSecretDestroy  Action = "secret.destroy"
	ActionSecretRestore  Action = "secret.restore"
	ActionAccessGrant    Action = "access.grant"
	ActionAccessRevoke   Action = "access.revoke"
	ActionAccessDeny     Action = "access.deny"
	ActionAccessAllow    Action = "access.allow"
	// The whitelist lives in Git, so these record a pull request being opened,
	// not access changing; that happens when someone else merges it.
	ActionWhitelistPropose  Action = "whitelist.propose"
	ActionWhitelistWithdraw Action = "whitelist.withdraw"
	ActionWhitelistRewire   Action = "whitelist.rewire"
	ActionReviewApprove     Action = "review.approve"
	ActionReviewMerge       Action = "review.merge"
	ActionReviewReject      Action = "review.reject"
)

type Outcome string

const (
	OutcomeAllowed Outcome = "allowed"
	OutcomeDenied  Outcome = "denied"
	OutcomeError   Outcome = "error"
)

type Event struct {
	Time   time.Time `json:"time"`
	Actor  string    `json:"actor"`
	Action Action    `json:"action"`
	Target string    `json:"target,omitempty"`
	// Backend names the secret store the action reached.
	Backend   string  `json:"backend,omitempty"`
	Outcome   Outcome `json:"outcome"`
	Reason    string  `json:"reason,omitempty"`
	RequestID string  `json:"requestId,omitempty"`
	SourceIP  string  `json:"sourceIp,omitempty"`

	// Keys names the fields a write touched. Values are never recorded.
	Keys []string `json:"keys,omitempty"`
}

type Logger struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func New(w io.Writer) *Logger {
	return &Logger{enc: json.NewEncoder(w)}
}

func (l *Logger) Record(e Event) {
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.enc.Encode(e)
}
