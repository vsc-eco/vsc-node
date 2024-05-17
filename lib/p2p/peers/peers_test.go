package peers_test

import (
	"testing"

	"github.com/vsc-eco/vsc-node/lib/p2p/peer"
	"github.com/vsc-eco/vsc-node/lib/p2p/peers"
)

func TestPeersValues(t *testing.T) {
	p := peers.New(nil)
	if len(p.Values()) != 0 {
		t.FailNow()
	}
	p.Push(peer.Peer("a"))
	v := p.Values()
	if len(v) != 1 || v[0] != peer.Peer("a") {
		t.FailNow()
	}
	v[0] = peer.Peer("b")
	if len(v) != 1 || p.Values()[0] != peer.Peer("a") {
		t.FailNow()
	}
}

func TestPeersClear(t *testing.T) {
	p := peers.New(nil)
	if len(p.Values()) != 0 {
		t.FailNow()
	}
	p.Push(peer.Peer("a"))
	if p.Size() != 1 {
		t.FailNow()
	}
	p.Clear()
	if p.Size() != 0 {
		t.FailNow()
	}
}
