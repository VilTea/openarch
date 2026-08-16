package httpapi

import (
	"net/http"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/application"
)

// RegisterDebtRoutes exposes the read-only Debt projection. Debt documents are
// Agent-owned Git facts; the service never creates or resolves them.
func RegisterDebtRoutes(mux *http.ServeMux, service application.DebtService) {
	mux.HandleFunc("GET /v1/debts", func(w http.ResponseWriter, r *http.Request) {
		filter, err := repositoryFilter(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid repositoryId filter: " + err.Error()})
			return
		}
		documents, err := service.List(r.Context(), string(filter))
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "list debts: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"debts": documents})
	})
}
