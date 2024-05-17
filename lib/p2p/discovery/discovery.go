package discovery

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/chebyrash/promise"
	"github.com/vsc-eco/vsc-node/lib/p2p/config"
	"github.com/vsc-eco/vsc-node/lib/p2p/peer"
	"github.com/vsc-eco/vsc-node/lib/p2p/peers"
	"github.com/vsc-eco/vsc-node/lib/utils"
	"github.com/vsc-eco/vsc-node/modules/aggregate"
)

type PeerDiscovery struct {
	peers  *peers.Peers
	config *config.Config

	fetchInterval *time.Ticker
	done          chan bool
}

const DiscoverInterval time.Duration = time.Minute

var _ aggregate.Plugin = &PeerDiscovery{}

func New(peers *peers.Peers, config *config.Config) *PeerDiscovery {
	return &PeerDiscovery{peers: peers, config: config}
}

// Init implements aggregate.Plugin.
func (p *PeerDiscovery) Init() error {
	p.fetchInterval = time.NewTicker(DiscoverInterval)
	p.done = make(chan bool)
	return nil
}

// Start implements aggregate.Plugin.
func (p *PeerDiscovery) Start() error {
	go func() {
		lastPeerCount := 0
		attempts := 0
		for peerCount := p.peers.Size(); lastPeerCount < peerCount || peerCount < int(p.config.MinPeers); peerCount = p.peers.Size() {
			p.fetchAndUpdatePeers()
			utils.Sleep(250 * time.Millisecond * time.Duration(math.Pow(2, float64(attempts))))
			attempts++
			lastPeerCount = peerCount
		}
	}()
	go func() {
		for {
			select {
			case <-p.done:
				return
			case <-p.fetchInterval.C:
				p.fetchAndUpdatePeers()
			}
		}
	}()

	return nil
}

// Stop implements aggregate.Plugin.
func (p *PeerDiscovery) Stop() error {
	p.fetchInterval.Stop()
	p.done <- true
	return nil
}

func (p *PeerDiscovery) fetchAndUpdatePeers() {
	// fmt.Println("fetching from peers")
	mutex := &sync.Mutex{}
	set := make(map[peer.Peer]struct{})
	promises := utils.Map(p.peers.Values(), func(pr peer.Peer) *promise.Promise[struct{}] {
		return promise.New(func(resolve func(struct{}), reject func(error)) {
			req, err := http.NewRequest("GET", "http://"+string(pr)+"/known_peers", nil)
			if err != nil {
				// fmt.Printf("peer %s failed to respond to /known_peers: %v\n", p, err)
				// TODO handle error cases better
				resolve(struct{}{})
				return
			}
			req.Header.Set("peer_id", p.config.Addr)
			r, err := http.DefaultClient.Do(req)
			if err != nil {
				// fmt.Printf("peer %s failed to respond to /known_peers: %v\n", p, err)
				// TODO handle error cases better
				resolve(struct{}{})
				return
			}
			resp, err := io.ReadAll(r.Body)
			if err != nil {
				// fmt.Printf("peer %s failed to respond to /known_peers: %v\n", p, err)
				// TODO handle error cases better
				resolve(struct{}{})
				return
			}
			foundPeers := make([]peer.Peer, 0)
			// fmt.Println(string(resp))
			err = json.Unmarshal(resp, &foundPeers)
			if err != nil {
				// fmt.Printf("peer %s failed to respond to /known_peers: %v\n", p, err)
				// TODO handle error cases better
				resolve(struct{}{})
				return
			}
			mutex.Lock()
			for _, peer := range foundPeers {
				set[peer] = struct{}{}
			}
			mutex.Unlock()
			resolve(struct{}{})
		})
	})
	promise.All(context.Background(), promises...).Await(context.Background())
	p.peers.Append(set)
}
