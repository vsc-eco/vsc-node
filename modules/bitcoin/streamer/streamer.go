package streamer

import (
	a "github.com/vsc-eco/vsc-node/modules/aggregate"
	"github.com/vsc-eco/vsc-node/modules/mongo"
)

type Streamer struct {
	db *mongo.Db
}

var _ a.Plugin = &Streamer{}

func New(db *mongo.Db) *Streamer {
	return &Streamer{db}
}

func (s *Streamer) Init() error {
	panic("unimplemented")
}

func (s *Streamer) Start() error {
	panic("unimplemented")
}

func (s *Streamer) Stop() error {
	panic("unimplemented")
}
