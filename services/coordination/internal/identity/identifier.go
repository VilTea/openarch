// Package identity contains stable identifier primitives shared by bounded
// contexts. It deliberately does not infer identity from paths or display
// names.
package identity

import "errors"

const MaxLength = 128

// Validate accepts the opaque ASCII identifiers used in durable cross-context
// keys. The grammar excludes path separators and whitespace by construction.
func Validate(value string) error {
	if len(value) == 0 || len(value) > MaxLength || !isStart(value[0]) {
		return errors.New("identifier must start with an ASCII letter or digit and be at most 128 bytes")
	}
	for index := 1; index < len(value); index++ {
		if !isPart(value[index]) {
			return errors.New("identifier contains an unsupported character")
		}
	}
	return nil
}

func isStart(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}

func isPart(value byte) bool {
	return isStart(value) || value == '.' || value == '_' || value == ':' || value == '@' || value == '-'
}
