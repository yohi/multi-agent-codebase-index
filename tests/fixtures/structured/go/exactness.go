package exactness

import "io"

// Reader is a reader interface.
type Reader interface {
	Read(p []byte) (n int, err error)
}

// Writer is a writer interface.
type Writer interface {
	Read(p []byte) (n int, err error)
}

//go:noinline
// Open opens a resource.
func Open(path string) (*Resource, error) {
	return &Resource{path: path}, nil
}

type Resource struct {
	path string
}

// Close closes the resource.
func (r *Resource) Close() error {
	r.path = ""
	return nil
}

func unexportedHelper() {
	// Intentionally empty: the parser must ignore unexported functions.
}

type Alias = Resource

type State int

const (
	StateIdle State = iota
	StateRunning
)
