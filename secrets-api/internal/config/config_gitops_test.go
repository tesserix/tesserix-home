package config

import "testing"

// An App-only deployment has no GITHUB_TOKEN. Gating on the PAT alone would
// silently disable proposals for exactly the configuration #464 migrates to —
// and it would look like a working service that simply never proposes.
func TestGitOpsEnabledAcceptsAnAppOnlyIdentity(t *testing.T) {
	if !(Config{GitHubAppID: "123456"}).GitOpsEnabled() {
		t.Fatal("an App-only config must count as GitOps-enabled")
	}
}

func TestGitOpsEnabledStillAcceptsAPersonalAccessToken(t *testing.T) {
	if !(Config{GitHubToken: "ghp_x"}).GitOpsEnabled() {
		t.Fatal("the PAT path must keep working, it is the rollback")
	}
}

func TestGitOpsDisabledWithNeitherCredential(t *testing.T) {
	if (Config{}).GitOpsEnabled() {
		t.Fatal("no credential must mean proposals are refused outright")
	}
}
