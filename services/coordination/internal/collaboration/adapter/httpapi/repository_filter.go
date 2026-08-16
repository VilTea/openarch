package httpapi

import (
	"net/http"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// repositoryFilter reads the optional `?repositoryId=` filter shared by live
// coordination read views. A multi-project docs-repo is one shared branch, so
// absent filter keeps the cross-project view; an explicit filter narrows the
// response to one repository. The filter is an operational view, not an
// authorization boundary: durable Git facts remain readable by every project
// that can read the shared docs-repo.
func repositoryFilter(r *http.Request) (domain.RepositoryID, error) {
	value := r.URL.Query().Get("repositoryId")
	if value == "" {
		return "", nil
	}
	id := domain.RepositoryID(value)
	if err := id.Validate(); err != nil {
		return "", err
	}
	return id, nil
}
