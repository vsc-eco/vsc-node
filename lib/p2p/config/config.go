package config

import (
	"encoding/json"

	"github.com/vsc-eco/vsc-node/lib/p2p/peer"
	"github.com/vsc-eco/vsc-node/modules/aggregate"
)

type Config struct {
	Peers    []peer.Peer
	Addr     string
	MinPeers uint64

	preInitialized bool
}

var _ aggregate.Plugin = &Config{}

func New() *Config {
	return &Config{MinPeers: 20}
}

func NewWithConfig(c Config) *Config {
	c.preInitialized = true
	return &c
}

// Init implements aggregate.Plugin.
func (c *Config) Init() error {
	if !c.preInitialized {
		// TODO read from config file
		data := make([]byte, 0)
		if err := json.Unmarshal(data, c); err != nil {
			return err
		}
	}
	return nil
}

// Start implements aggregate.Plugin.
func (c *Config) Start() error {
	// TODO maybe listen to file updates?
	return nil
}

// Stop implements aggregate.Plugin.
func (c *Config) Stop() error {
	return nil
}
