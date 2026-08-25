package signing

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
	"github.com/openarch/openarch/services/coordination/internal/identity"
)

var _ port.TaskEventAuthenticator = (*Ed25519TaskEventAuthenticator)(nil)

// Ed25519TaskEventAuthenticator separates the service-held private key from
// Git content. Anyone with a trusted public key can verify an event, but an
// Agent that can push documents cannot forge one.
type Ed25519TaskEventAuthenticator struct {
	keyID      string
	private    ed25519.PrivateKey
	public     ed25519.PublicKey
	verifyKeys map[string]ed25519.PublicKey
}

func LoadEd25519TaskEventAuthenticator(keyID string, privateKeyFile string, verifyKeys ...string) (*Ed25519TaskEventAuthenticator, error) {
	encoded, err := os.ReadFile(privateKeyFile)
	if err != nil {
		return nil, fmt.Errorf("read task signing key: %w", err)
	}
	key, err := decodePrivateKey(encoded)
	if err != nil {
		return nil, err
	}
	return NewEd25519TaskEventAuthenticator(keyID, key, verifyKeys...)
}

// NewEd25519TaskEventAuthenticator builds an authenticator whose current
// signing key is trusted under keyID. Additional verifyKeys use
// "<keyId>:<base64 public key>" and allow old events to remain verifiable
// after key rotation.
func NewEd25519TaskEventAuthenticator(keyID string, private ed25519.PrivateKey, verifyKeys ...string) (*Ed25519TaskEventAuthenticator, error) {
	if err := identity.Validate(keyID); err != nil {
		return nil, fmt.Errorf("task signing key id: %w", err)
	}
	if len(private) != ed25519.PrivateKeySize {
		return nil, errors.New("task signing key must be an Ed25519 private key")
	}
	public := private.Public().(ed25519.PublicKey)
	verify := map[string]ed25519.PublicKey{keyID: public}
	for _, spec := range verifyKeys {
		verifyKeyID, verifyPublic, err := ParseVerifyKey(spec)
		if err != nil {
			return nil, err
		}
		if _, exists := verify[verifyKeyID]; exists {
			return nil, fmt.Errorf("duplicate task verify key id %q", verifyKeyID)
		}
		verify[verifyKeyID] = verifyPublic
	}
	return &Ed25519TaskEventAuthenticator{keyID: keyID, private: private, public: public, verifyKeys: verify}, nil
}

// ParseVerifyKey parses "<keyId>:<base64 raw Ed25519 public key>".
func ParseVerifyKey(spec string) (string, ed25519.PublicKey, error) {
	keyID, encoded, ok := strings.Cut(strings.TrimSpace(spec), ":")
	if !ok {
		return "", nil, errors.New("task verify key must be \"keyId:base64public\"")
	}
	if err := identity.Validate(keyID); err != nil {
		return "", nil, fmt.Errorf("task verify key id: %w", err)
	}
	public, err := base64.RawStdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil || len(public) != ed25519.PublicKeySize {
		return "", nil, errors.New("task verify key must contain a base64 raw Ed25519 public key")
	}
	return keyID, ed25519.PublicKey(public), nil
}

func (a *Ed25519TaskEventAuthenticator) SignTaskEvent(event domain.TaskLifecycleEvent) (domain.TaskLifecycleEvent, error) {
	event.SignerKeyID = a.keyID
	eventHash, err := event.ComputeEventHash()
	if err != nil {
		return domain.TaskLifecycleEvent{}, err
	}
	event.EventHash = eventHash
	payload, err := event.SigningPayload()
	if err != nil {
		return domain.TaskLifecycleEvent{}, err
	}
	event.Signature = base64.RawStdEncoding.EncodeToString(ed25519.Sign(a.private, payload))
	return event, event.Validate()
}

func (a *Ed25519TaskEventAuthenticator) VerifyTaskEvent(event domain.TaskLifecycleEvent) error {
	if err := event.Validate(); err != nil {
		return err
	}
	public, ok := a.verifyKeys[event.SignerKeyID]
	if !ok {
		return fmt.Errorf("task event signer key %q is not trusted", event.SignerKeyID)
	}
	payload, err := event.SigningPayload()
	if err != nil {
		return err
	}
	signature, err := base64.RawStdEncoding.DecodeString(event.Signature)
	if err != nil || !ed25519.Verify(public, payload, signature) {
		return errors.New("task event signature verification failed")
	}
	return nil
}

func decodePrivateKey(encoded []byte) (ed25519.PrivateKey, error) {
	key, err := base64.RawStdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		return nil, errors.New("task signing key must be base64 raw Ed25519 seed or private key")
	}
	switch len(key) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(key), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(key), nil
	default:
		return nil, errors.New("task signing key must decode to an Ed25519 seed or private key")
	}
}
