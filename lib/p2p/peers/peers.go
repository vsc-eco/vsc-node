package peers

import (
	"encoding/json"
	"strings"
	"sync"
	"unsafe"

	"github.com/vsc-eco/vsc-node/lib/p2p/config"
	"github.com/vsc-eco/vsc-node/lib/p2p/peer"
	"github.com/vsc-eco/vsc-node/modules/aggregate"
	"github.com/zyedidia/generic/heap"
)

type Peers struct {
	mutex  *sync.RWMutex
	heap   *heap.Heap[peer.Peer]
	config *config.Config
}

var _ aggregate.Plugin = &Peers{}
var _ json.Marshaler = &Peers{}

func New(config *config.Config) *Peers {
	return &Peers{
		&sync.RWMutex{},
		heap.New(func(a, b peer.Peer) bool { return strings.Compare(string(a), string(b)) < 0 }),
		config,
	}
}

func (peers *Peers) data() *[]peer.Peer {
	type a_internalType[T any] struct {
		data []T
		less func(a, b T) bool
	}

	return &((*a_internalType[peer.Peer])(unsafe.Pointer(peers.heap))).data
}

// clears all saved peers
// WARNING: not thread safe
func (peers *Peers) unsafeClear() {
	*peers.data() = make([]peer.Peer, 0)
}

func (peers *Peers) Clear() {
	peers.mutex.Lock()
	peers.unsafeClear()
	peers.mutex.Unlock()
}

func (peers *Peers) Values() []peer.Peer {
	peers.mutex.RLock()
	res := make([]peer.Peer, len(*peers.data()))
	copy(res, *peers.data())
	peers.mutex.RUnlock()

	return res
}

func (peers *Peers) Size() int {
	peers.mutex.RLock()
	defer peers.mutex.RUnlock()
	return peers.heap.Size()
}

// inserts a new peer
// WARNING: not thread safe
func (peers *Peers) unsafePush(peer peer.Peer) {
	peers.heap.Push(peer)
}

func (peers *Peers) Push(peer peer.Peer) {
	peers.mutex.Lock()
	defer peers.mutex.Unlock()
	peers.unsafePush(peer)
}

// Adds `newPeers` to `Peers`
// Note appends current peers to `newPeers`
func (peers *Peers) Append(newPeers map[peer.Peer]struct{}) {
	peers.mutex.Lock()
	defer peers.mutex.Unlock()
	for _, peer := range *peers.data() {
		newPeers[peer] = struct{}{}
	}
	peers.unsafeClear()
	for peer := range newPeers {
		peers.unsafePush(peer)
	}
}

func (peers *Peers) AppendSingle(p peer.Peer) {
	newPeers := make(map[peer.Peer]struct{})
	newPeers[p] = struct{}{}
	peers.mutex.Lock()
	defer peers.mutex.Unlock()
	for _, peer := range *peers.data() {
		newPeers[peer] = struct{}{}
	}
	peers.unsafeClear()
	for peer := range newPeers {
		peers.unsafePush(peer)
	}
}

// Init implements aggregate.Plugin.
func (p *Peers) Init() error {
	for _, peer := range p.config.Peers {
		p.Push(peer)
	}
	return nil
}

// Start implements aggregate.Plugin.
func (p *Peers) Start() error {
	p.Push(peer.Peer(p.config.Host()))
	return nil
}

// Stop implements aggregate.Plugin.
func (p *Peers) Stop() error {
	return nil
}

// MarshalJSON implements json.Marshaler.
func (peers *Peers) MarshalJSON() ([]byte, error) {
	peers.mutex.RLock()
	defer peers.mutex.RUnlock()
	return json.Marshal(*peers.data())
}
