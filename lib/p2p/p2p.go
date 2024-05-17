package p2p

import (
	"bytes"
	"context"
	nhttp "net/http"

	"github.com/chebyrash/promise"
	"github.com/vsc-eco/vsc-node/lib/p2p/config"
	"github.com/vsc-eco/vsc-node/lib/p2p/discovery"
	"github.com/vsc-eco/vsc-node/lib/p2p/http"
	"github.com/vsc-eco/vsc-node/lib/p2p/peer"
	"github.com/vsc-eco/vsc-node/lib/p2p/peers"
	"github.com/vsc-eco/vsc-node/lib/utils"
	"github.com/vsc-eco/vsc-node/modules/aggregate"
)

type P2p struct {
	*aggregate.Aggregate

	peers  *peers.Peers
	server *http.HttpServer
}

type ExtraFunc func(config *config.Config, peers *peers.Peers, discovery *discovery.PeerDiscovery, http *http.HttpServer) aggregate.Plugin

func New() *P2p {
	cfg := config.New()
	return NewWithConfig(cfg)
}

func NewWithConfig(cfg *config.Config, extras ...ExtraFunc) *P2p {
	prs := peers.New(cfg)
	disc := discovery.New(prs, cfg)
	server := http.New(cfg, prs)
	return &P2p{
		aggregate.New(
			append([]aggregate.Plugin{
				cfg,
				prs,
				disc,
				server,
			},
				utils.Map(extras, func(extra ExtraFunc) aggregate.Plugin {
					return extra(cfg, prs, disc, server)
				})...,
			),
		),
		prs,
		server,
	}
}

func (p2p *P2p) Subscribe(topic string, handler func([]byte)) {
	p2p.server.AddMessageHandler(topic, handler)
}

func (p2p *P2p) Unsubscribe(topic string, handler func([]byte)) {
	p2p.server.RemoveMessageHandler(topic, handler)
}

func (p2p *P2p) SendToAll(topic string, message []byte) {
	p2p.SendTo(topic, message, p2p.Peers())
}

func (p2p *P2p) SendTo(topic string, message []byte, recipients []peer.Peer) {
	promise.All(context.Background(), utils.Map(recipients, func(p peer.Peer) *promise.Promise[struct{}] {
		return promise.New(func(resolve func(struct{}), reject func(error)) {
			req, err := nhttp.NewRequest("POST", p.MsgUrl(), bytes.NewBuffer(message))
			if err != nil {
				// TODO don't ignore
				resolve(struct{}{})
				return
			}
			req.Header.Set("type", topic)
			// TODO don't ignore potentially an error result
			nhttp.DefaultClient.Do(req)
			resolve(struct{}{})
		})
	})...).Await(context.Background())
}

func (p2p *P2p) Peers() []peer.Peer {
	return p2p.peers.Values()
}
