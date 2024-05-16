package mongo

import (
	a "github.com/vsc-eco/vsc-node/modules/aggregate"
)

type Db struct{}

var _ a.Plugin = &Db{}

func New() *Db {
	return &Db{}
}

func (s *Db) Init() error {
	panic("unimplemented")
}

func (s *Db) Start() error {
	panic("unimplemented")
}

func (s *Db) Stop() error {
	panic("unimplemented")
}
