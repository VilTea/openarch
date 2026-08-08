package domain

type Calibration struct {
	ProviderID          string         `json:"providerId"`
	ProviderVersion     string         `json:"providerVersion"`
	RuleID              string         `json:"ruleId"`
	AuthorityID         string         `json:"authorityId"`
	Projects            int            `json:"projects"`
	Samples             int            `json:"samples"`
	AverageFindingCount float64        `json:"averageFindingCount"`
	VerdictCounts       map[string]int `json:"verdictCounts"`
	Recommendation      string         `json:"recommendation"`
}

func AggregateCalibration(key CalibrationKey, records []ValidationEvidence) Calibration {
	calibration := Calibration{
		ProviderID:    key.ProviderID,
		RuleID:        key.RuleID,
		AuthorityID:   key.AuthorityID,
		VerdictCounts: map[string]int{},
	}
	projects := map[string]struct{}{}
	totalFindings := 0

	for _, evidence := range records {
		if evidence.CalibrationKey() != key {
			continue
		}
		calibration.Samples++
		totalFindings += evidence.FindingCount
		projects[evidence.ProjectToken] = struct{}{}
		calibration.ProviderVersion = evidence.Provider.Version
		calibration.VerdictCounts[evidence.PolicyVerdict]++
	}

	calibration.Projects = len(projects)
	if calibration.Samples > 0 {
		calibration.AverageFindingCount = float64(totalFindings) / float64(calibration.Samples)
	}
	if calibration.Projects < 2 {
		calibration.Recommendation = "insufficient cross-project evidence; keep this provider review-only"
	} else {
		calibration.Recommendation = "cross-project evidence is available; review calibration with each project before any local policy change"
	}
	return calibration
}
