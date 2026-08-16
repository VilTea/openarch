package ndjson

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
)

type Store struct {
	path string
	mu   sync.Mutex
}

func Open(path string) (*Store, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &Store{path: path}, file.Close()
}

func (s *Store) Close() error { return nil }

func (s *Store) listEvidence() ([]domain.ValidationEvidence, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := os.Open(s.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	records := make([]domain.ValidationEvidence, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024), 64<<10)
	for scanner.Scan() {
		var evidence domain.ValidationEvidence
		if err := json.Unmarshal(scanner.Bytes(), &evidence); err != nil {
			return nil, err
		}
		records = append(records, evidence)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

func (s *Store) ReplaceEvidence(_ context.Context, evidence []domain.ValidationEvidence) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Dir(s.path)
	temporary, err := os.CreateTemp(dir, ".openarch-projection-*.ndjson")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	encoder := json.NewEncoder(temporary)
	for _, record := range evidence {
		if err := encoder.Encode(record); err != nil {
			temporary.Close()
			return err
		}
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	// 同目录 temp + rename：并发进程不会读到被截断一半的投影。
	return os.Rename(temporaryPath, s.path)
}

func (s *Store) CalibrationByKey(_ context.Context, key domain.CalibrationKey) (domain.Calibration, error) {
	records, err := s.listEvidence()
	if err != nil {
		return domain.Calibration{}, err
	}
	return domain.AggregateCalibration(key, records), nil
}
