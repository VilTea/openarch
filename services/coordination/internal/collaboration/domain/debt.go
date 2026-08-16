package domain

import (
	"errors"
	"fmt"
	"strings"

	"github.com/openarch/openarch/services/coordination/internal/identity"
)

const DebtSchemaVersion = "1"

// DebtRef binds a deferred decision to one declared service. A product-wide
// debt must explicitly list affected service documents and cannot use an
// unscoped global identity.
type DebtRef struct {
	RepositoryID RepositoryID `json:"repositoryId"`
	ServiceID    ServiceID    `json:"serviceId"`
	DebtID       string       `json:"debtId"`
}

func (ref DebtRef) Validate() error {
	if err := ref.RepositoryID.Validate(); err != nil {
		return err
	}
	if err := ref.ServiceID.Validate(); err != nil {
		return err
	}
	if err := identity.Validate(ref.DebtID); err != nil {
		return fmt.Errorf("debtId: %w", err)
	}
	return nil
}

func (ref DebtRef) Service() ServiceRef {
	return ServiceRef{RepositoryID: ref.RepositoryID, ID: ref.ServiceID}
}

// DebtDocument is an Agent-owned deferred decision. It has no assignee,
// session, lock or execution progress; it becomes work only through an
// explicit Task proposal.
type DebtDocument struct {
	SchemaVersion       string  `json:"schemaVersion"`
	Debt                DebtRef `json:"debt"`
	Title               string  `json:"title"`
	Reason              string  `json:"reason"`
	ReconsiderCondition string  `json:"reconsiderCondition"`
	AcceptanceCriteria  string  `json:"acceptanceCriteria,omitempty"`
	Status              string  `json:"status"`
}

func (document DebtDocument) Validate() error {
	if document.SchemaVersion != DebtSchemaVersion {
		return fmt.Errorf("debt schema must be %q", DebtSchemaVersion)
	}
	if err := document.Debt.Validate(); err != nil {
		return err
	}
	if title := strings.TrimSpace(document.Title); title == "" || len(title) > 240 {
		return errors.New("debt title must be 1..240 characters")
	}
	if reason := strings.TrimSpace(document.Reason); reason == "" || len(reason) > 2000 {
		return errors.New("debt reason must be 1..2000 characters")
	}
	if condition := strings.TrimSpace(document.ReconsiderCondition); condition == "" || len(condition) > 500 {
		return errors.New("debt reconsiderCondition must be 1..500 characters")
	}
	switch document.Status {
	case "deferred", "accepted", "resolved", "superseded":
	default:
		return errors.New("debt status must be deferred, accepted, resolved, or superseded")
	}
	return nil
}

func DebtPath(ref DebtRef) string {
	return "debts/" + string(ref.RepositoryID) + "/" + string(ref.ServiceID) + "/" + ref.DebtID + ".json"
}
