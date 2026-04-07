// Package sample provides sample types for testing.
package sample

import (
	"context"
	"fmt"
	"encoding/json"
)

// MaxRetries is the maximum number of retries.
const MaxRetries = 3

var counter int

// User represents a user in the system.
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Result is a generic result type.
type Result interface {
	Error() error
}

// Status represents the status of an entity.
type Status int

const (
	StatusActive   Status = iota
	StatusInactive
)

// UserService manages users.
type UserService struct {
	db interface{}
}

// NewUserService creates a new UserService.
func NewUserService(db interface{}) *UserService {
	return &UserService{db: db}
}

// FindUser finds a user by ID.
func (s *UserService) FindUser(ctx context.Context, id string) (*User, error) {
	return nil, nil
}

// Greet greets a person by name.
func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

// FetchData fetches data from a URL.
func FetchData(url string) ([]byte, error) {
	data, _ := json.Marshal(url)
	return data, nil
}
