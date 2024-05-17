package peer

type Peer string

type Route string

const (
	RouteSendMsg    Route = "/send_message"
	RouteKnownPeers Route = "/known_peers"
)

func (peer *Peer) MsgUrl() string {
	return peer.routeUrl(RouteSendMsg)
}

func (peer *Peer) PeersUrl() string {
	return peer.routeUrl(RouteKnownPeers)
}

func (peer *Peer) routeUrl(route Route) string {
	return "http://" + string(*peer) + string(route)
}
