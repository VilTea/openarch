package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/identity"
)

type Window struct {
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt"`
}

type Provider struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

type CalibrationKey struct {
	ProviderID  string `json:"providerId"`
	RuleID      string `json:"ruleId"`
	AuthorityID string `json:"authorityId"`
}

func (k CalibrationKey) Validate() error {
	if identity.Validate(k.ProviderID) != nil || identity.Validate(k.RuleID) != nil || identity.Validate(k.AuthorityID) != nil {
		return errors.New("providerId, ruleId, and authorityId must be stable identifiers")
	}
	return nil
}

type ValidationEvidence struct {
	SchemaVersion               string    `json:"schemaVersion"`
	ProjectToken                string    `json:"projectToken"`
	ObservedAt                  time.Time `json:"observedAt"`
	Window                      Window    `json:"window"`
	OpenArchVersion             string    `json:"openarchVersion"`
	Languages                   []string  `json:"languages"`
	Provider                    Provider  `json:"provider"`
	RuleID                      string    `json:"ruleId"`
	AuthorityID                 string    `json:"authorityId"`
	FindingCount                int       `json:"findingCount"`
	PolicyVerdict               string    `json:"policyVerdict"`
	ConfirmedFalsePositiveCount int       `json:"confirmedFalsePositiveCount"`
	ConfirmedFalseNegativeCount int       `json:"confirmedFalseNegativeCount"`
	EvidenceLevel               string    `json:"evidenceLevel"`
}

func (v ValidationEvidence) Validate() error {
	if v.SchemaVersion != "2" || strings.TrimSpace(v.ProjectToken) == "" || strings.TrimSpace(v.OpenArchVersion) == "" || strings.TrimSpace(v.Provider.Version) == "" || v.CalibrationKey().Validate() != nil {
		return errors.New("schemaVersion, projectToken, OpenArch version, provider, rule, and authority are required")
	}
	if len(v.Languages) == 0 || v.ObservedAt.IsZero() || v.Window.StartedAt.IsZero() || v.Window.EndedAt.IsZero() || v.Window.StartedAt.After(v.Window.EndedAt) {
		return errors.New("languages and an ordered time window are required")
	}
	if v.FindingCount < 0 || v.ConfirmedFalsePositiveCount < 0 || v.ConfirmedFalseNegativeCount < 0 {
		return errors.New("counts must be non-negative")
	}
	if v.PolicyVerdict != "PASS" && v.PolicyVerdict != "WARN" && v.PolicyVerdict != "BLOCK" {
		return errors.New("policyVerdict must be PASS, WARN, or BLOCK")
	}
	if v.EvidenceLevel != "observed" && v.EvidenceLevel != "reviewed" && v.EvidenceLevel != "confirmed" {
		return errors.New("invalid evidenceLevel")
	}
	return nil
}

func (v ValidationEvidence) CalibrationKey() CalibrationKey {
	return CalibrationKey{ProviderID: v.Provider.ID, RuleID: v.RuleID, AuthorityID: v.AuthorityID}
}

// ObservationFingerprint identifies the calibration conclusion, not the time
// at which a client happened to observe it. Re-running an unchanged CI check
// therefore remains idempotent while a changed finding/verdict is retained.
func (v ValidationEvidence) ObservationFingerprint() string {
	languages := append([]string(nil), v.Languages...)
	sort.Strings(languages)
	identity := struct {
		SchemaVersion      string   `json:"schemaVersion"`
		ProjectToken       string   `json:"projectToken"`
		OpenArchVersion    string   `json:"openarchVersion"`
		Languages          []string `json:"languages"`
		Provider           Provider `json:"provider"`
		RuleID             string   `json:"ruleId"`
		AuthorityID        string   `json:"authorityId"`
		FindingCount       int      `json:"findingCount"`
		PolicyVerdict      string   `json:"policyVerdict"`
		FalsePositiveCount int      `json:"confirmedFalsePositiveCount"`
		FalseNegativeCount int      `json:"confirmedFalseNegativeCount"`
		EvidenceLevel      string   `json:"evidenceLevel"`
	}{
		SchemaVersion: v.SchemaVersion, ProjectToken: v.ProjectToken, OpenArchVersion: v.OpenArchVersion,
		Languages: languages, Provider: v.Provider, RuleID: v.RuleID, AuthorityID: v.AuthorityID,
		FindingCount: v.FindingCount, PolicyVerdict: v.PolicyVerdict,
		FalsePositiveCount: v.ConfirmedFalsePositiveCount, FalseNegativeCount: v.ConfirmedFalseNegativeCount,
		EvidenceLevel: v.EvidenceLevel,
	}
	payload, _ := json.Marshal(identity)
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// ObservationSlotFingerprint bounds the active authority record to one latest
// calibration conclusion per project/key/language scope. Git history remains
// the audit trail when that conclusion changes.
func (v ValidationEvidence) ObservationSlotFingerprint() string {
	languages := append([]string(nil), v.Languages...)
	sort.Strings(languages)
	identity := struct {
		SchemaVersion string   `json:"schemaVersion"`
		ProjectToken  string   `json:"projectToken"`
		Languages     []string `json:"languages"`
		ProviderID    string   `json:"providerId"`
		RuleID        string   `json:"ruleId"`
		AuthorityID   string   `json:"authorityId"`
	}{
		SchemaVersion: v.SchemaVersion, ProjectToken: v.ProjectToken, Languages: languages,
		ProviderID: v.Provider.ID, RuleID: v.RuleID, AuthorityID: v.AuthorityID,
	}
	payload, _ := json.Marshal(identity)
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
