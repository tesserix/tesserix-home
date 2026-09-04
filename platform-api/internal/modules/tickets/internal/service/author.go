package service

import (
	"fmt"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// Bounds on a relayed merchant's identity.
//
// The same limits apps/web's schema enforces (name 200, email 300, user id
// 200), because these are written to the same columns by the same product.
// Tightening them here would reject replies that are accepted today.
const (
	maxAuthorName   = 200
	maxAuthorEmail  = 300
	maxAuthorUserID = 200
)

// Author is the merchant a product's machine is relaying.
//
// Nil for an operator's own reply. Present, and required, for a machine's:
// the whole point of the contract is that a machine must SAY whom it speaks
// for rather than being silently attributed to the platform.
//
// Email and UserID are optional, matching apps/web's schema — a merchant
// without a stored address still gets to reply.
type Author struct {
	Name   string
	Email  string
	UserID string
}

// replyAuthor is how a reply is attributed on a merchant's thread.
type replyAuthor struct {
	Type   domain.AuthorType
	Name   string
	Email  string
	UserID string
}

// authorFor decides who a reply is from.
//
// # Why this is one function rather than a field on the insert
//
// Because the two cases are opposite, and the code before #152 could only
// express one. service.Reply hardcoded AuthorOperator and the fixed platform
// label, which was correct while the console was the only caller and became a
// live-data defect the moment a product's machine could reach the route: a
// product relays a MERCHANT, and apps/web writes those replies as
// author_type "merchant" with the merchant's own identity.
//
// # The two rules, and why each refuses rather than falls back
//
// An OPERATOR may not supply an author. Allowing it would let anyone holding
// the console's write capability forge a message from a named merchant onto
// that merchant's own thread.
//
// A MACHINE must supply one. Falling back to the platform label is exactly the
// corruption this exists to prevent, and it would be invisible: the reply
// would store and render fine, just as though the support team had said it.
func authorFor(scope Scope, actor Actor, requested *Author) (replyAuthor, error) {
	if scope.Unscoped() {
		if requested != nil {
			return replyAuthor{}, fmt.Errorf(
				"%w: an operator may not post as a merchant", ErrRefused)
		}
		// Unchanged: the platform's own label, the operator's subject kept for
		// internal attribution but never shown. See Actor.displayName.
		return replyAuthor{
			Type:   domain.AuthorOperator,
			Name:   actor.displayName(),
			Email:  "",
			UserID: actor.Subject,
		}, nil
	}

	if requested == nil {
		return replyAuthor{}, fmt.Errorf(
			"%w: a product caller must say which merchant it is relaying", ErrRefused)
	}

	name := strings.TrimSpace(requested.Name)
	email := strings.TrimSpace(requested.Email)
	userID := strings.TrimSpace(requested.UserID)

	// Trimmed BEFORE the emptiness check, so a name of spaces is an absent
	// name. author_name is NOT NULL and the console renders it directly, so a
	// blank one produces a message that appears to be from nobody.
	if name == "" {
		return replyAuthor{}, fmt.Errorf(
			"%w: a merchant author needs a name", ErrRefused)
	}
	if len(name) > maxAuthorName {
		return replyAuthor{}, fmt.Errorf(
			"%w: a merchant name is limited to %d characters", ErrRefused, maxAuthorName)
	}
	if len(email) > maxAuthorEmail {
		return replyAuthor{}, fmt.Errorf(
			"%w: a merchant email is limited to %d characters", ErrRefused, maxAuthorEmail)
	}
	if len(userID) > maxAuthorUserID {
		return replyAuthor{}, fmt.Errorf(
			"%w: a merchant user id is limited to %d characters", ErrRefused, maxAuthorUserID)
	}

	return replyAuthor{
		Type:   domain.AuthorMerchant,
		Name:   name,
		Email:  email,
		UserID: userID,
	}, nil
}
