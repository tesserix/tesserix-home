// Package domain holds the audit module's types.
package domain

import (
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Entry is one audit row, from any source.
type Entry struct {
	ID           string    `json:"id"`
	Action       string    `json:"action"`
	ActorEmail   string    `json:"actor_email,omitempty"`
	ResourceType string    `json:"resource_type,omitempty"`
	ResourceID   string    `json:"resource_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	// Source is REQUIRED on every row. "Who did what" without "where" is not a
	// whole answer, and the console renders this column.
	Source string `json:"source"`
}

// Page is the surface's response: what was read, and what could not be.
type Page struct {
	Entries  []Entry              `json:"entries"`
	Failures []federation.Failure `json:"failures"`
}
