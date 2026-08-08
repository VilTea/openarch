package docsrepo

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// decodeStrictJSON keeps every Agent-owned document boundary consistent:
// unknown fields and trailing values are rejected before domain validation.
func decodeStrictJSON(payload []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON data")
		}
		return err
	}
	return nil
}
