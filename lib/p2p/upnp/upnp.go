package upnp

import (
	"gitlab.com/NebulousLabs/go-upnp"

	"github.com/vsc-eco/vsc-node/lib/p2p/config"
	"github.com/vsc-eco/vsc-node/modules/aggregate"
)

type UPnP struct {
	config *config.Config

	router   *upnp.IGD
	publicIP string
}

func New(config *config.Config) *UPnP {
	return &UPnP{config: config}
}

func (u *UPnP) PublicIpAddress() string {
	return u.publicIP
}

// Init implements aggregate.Plugin.
func (u *UPnP) Init() error {
	// connect to router
	d, err := upnp.Discover()
	if err != nil {
		return err
	}

	u.router = d

	// discover external IP
	ip, err := d.ExternalIP()
	if err != nil {
		return err
	}

	u.publicIP = ip

	// // record router's location
	// loc := d.Location()

	// // connect to router directly
	// d, err = upnp.Load(loc)
	// if err != nil {
	//     log.Fatal(err)
	// }

	return nil
}

// Start implements aggregate.Plugin.
func (u *UPnP) Start() error {
	// forward a port
	return u.router.Forward(u.config.Port, "p2p service")
	// TODO change service name
}

// Stop implements aggregate.Plugin.
func (u *UPnP) Stop() error {
	// un-forward a port
	return u.router.Clear(u.config.Port)
}

var _ aggregate.Plugin = &UPnP{}
