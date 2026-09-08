package handler

import (
	"os"
	"regexp"
	"sort"
	"testing"
)

// The guard that would have caught a live 400 on the console's Trials tab.
//
// `include_ended` was parsed by trialsHandler and missing from
// trialParameters, so RejectUnknownParameters refused the request BEFORE the
// parse ran: the console asked for a parameter this handler understands, and
// was told the endpoint does not read it. The whole tab errored.
//
// Nothing failed. The parse compiled, every unit test passed, and the two
// lists sat six hundred lines apart with nothing tying them together.
//
// So this reads the source and asserts the tie directly: every parameter the
// trials handler READS must be one it ALLOWS. A source scan is a blunt
// instrument, and it is the right one here — the coupling is between two
// literals in one file, and any indirection clever enough to defeat the regex
// is also clever enough to have made the bug impossible.
func TestTrialParametersCoverEveryParameterRead(t *testing.T) {
	src, err := os.ReadFile("handler.go")
	if err != nil {
		t.Fatalf("read handler.go: %v", err)
	}

	// The trials read is the region from its handler to the end of the
	// function; scanning the whole file would pick up the subscriptions and
	// entitlements reads, which have their own allow-lists.
	body := string(src)
	start := regexp.MustCompile(`func \(h \*Handler\) trials\w*\(`).FindStringIndex(body)
	if start == nil {
		t.Fatal("could not find the trials handler; update this test rather than deleting it")
	}
	region := body[start[1]:]
	if end := regexp.MustCompile(`\nfunc `).FindStringIndex(region); end != nil {
		region = region[:end[0]]
	}

	read := regexp.MustCompile(`query\.Get\("([^"]+)"\)`).FindAllStringSubmatch(region, -1)
	if len(read) == 0 {
		t.Fatal("found no query.Get calls in the trials handler; the scan is wrong")
	}

	allowed := map[string]struct{}{}
	for _, name := range trialParameters {
		allowed[name] = struct{}{}
	}

	var missing []string
	for _, m := range read {
		if _, ok := allowed[m[1]]; !ok {
			missing = append(missing, m[1])
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("trialsHandler reads %v but trialParameters does not allow them — "+
			"every request carrying one gets a 400 naming a parameter this endpoint "+
			"actually understands", missing)
	}
}

// The reverse direction is deliberately NOT asserted. `limit` and `days` are
// read through helpers rather than query.Get, and an allowed-but-unread
// parameter is merely inert — it accepts something harmless, which is a far
// smaller problem than refusing something valid.
func TestTrialParametersAllowsTheFlagsTheConsoleSends(t *testing.T) {
	// The console's widest scope sends all four. Named explicitly because
	// this is the contract the Trials tab depends on, and a silent removal
	// here breaks that page with a 400 rather than a wrong result.
	for _, name := range []string{"days", "include_signup", "include_stripe_managed", "include_ended"} {
		var found bool
		for _, allowed := range trialParameters {
			if allowed == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("trialParameters is missing %q, which the console sends", name)
		}
	}
}
