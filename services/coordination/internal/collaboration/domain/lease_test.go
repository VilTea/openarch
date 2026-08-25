package domain

import (
	"testing"
)

func TestNormalizeTarget(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		expect string
	}{
		{name: "file prefix lower-cased and separators normalized", input: " FILE:src\\feature.ts ", expect: "file:src/feature.ts"},
		{name: "file prefix already canonical", input: "file:src/feature.ts", expect: "file:src/feature.ts"},
		{name: "function prefix lower-cased", input: "FUNCTION:pkg.Authority.AppendEvidence", expect: "function:pkg.Authority.AppendEvidence"},
		{name: "type prefix lower-cased", input: "TYPE:User", expect: "type:User"},
		{name: "legacy identity unchanged", input: "services/coordination#Authority.AppendEvidence", expect: "services/coordination#Authority.AppendEvidence"},
		{name: "plain path unchanged without prefix", input: "src/target.ts", expect: "src/target.ts"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NormalizeTarget(tt.input); got != tt.expect {
				t.Fatalf("NormalizeTarget(%q) = %q, want %q", tt.input, got, tt.expect)
			}
		})
	}
}

func TestNewLeaseKeyNormalizesTarget(t *testing.T) {
	repository := RepositoryRef{ID: "repo-1"}
	key, err := NewLeaseKey(repository, " FILE:src\\feature.ts ")
	if err != nil {
		t.Fatal(err)
	}
	if key.Target != "file:src/feature.ts" {
		t.Fatalf("key.Target = %q, want %q", key.Target, "file:src/feature.ts")
	}
}

func TestNewLeaseKeyRejectsUnprefixedTarget(t *testing.T) {
	repository := RepositoryRef{ID: "repo-1"}
	if _, err := NewLeaseKey(repository, "src/target.ts"); err == nil {
		t.Fatal("expected unprefixed semantic lease target to be rejected")
	}
}
