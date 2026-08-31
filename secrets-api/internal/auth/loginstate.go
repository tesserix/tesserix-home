package auth

import "time"

// LoginState is the short-lived server state of one in-flight login, carried in
// a sealed cookie so no session store is needed.
type LoginState struct {
	State     string    `json:"state"`
	Verifier  string    `json:"verifier"`
	ReturnTo  string    `json:"returnTo,omitempty"`
	ExpiresAt time.Time `json:"exp"`
}

func (s *Sealer) SealLoginState(ls LoginState) (string, error) {
	return s.seal(purposeLogin, ls)
}

func (s *Sealer) OpenLoginState(token string) (LoginState, error) {
	var ls LoginState
	if err := s.open(purposeLogin, token, &ls); err != nil {
		return LoginState{}, err
	}
	if !ls.ExpiresAt.After(s.now()) {
		return LoginState{}, ErrSessionExpired
	}
	return ls, nil
}
