package http

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/vsc-eco/vsc-node/lib/p2p/config"
	"github.com/vsc-eco/vsc-node/lib/p2p/peer"
	"github.com/vsc-eco/vsc-node/lib/p2p/peers"
	"github.com/vsc-eco/vsc-node/lib/utils"
	"github.com/vsc-eco/vsc-node/modules/aggregate"
)

type HttpServer struct {
	config *config.Config
	peers  *peers.Peers

	server          *http.Server
	messageHandlers map[string][]func([]byte)
}

var _ aggregate.Plugin = &HttpServer{}

func New(c *config.Config, p *peers.Peers) *HttpServer {
	return &HttpServer{config: c, peers: p}
}

func (h *HttpServer) AddMessageHandler(topic string, handler func([]byte)) {
	handlers, initialized := h.messageHandlers[topic]
	if initialized {
		h.messageHandlers[topic] = append(handlers, handler)
	} else {
		h.messageHandlers[topic] = []func([]byte){handler}
	}
}

func (h *HttpServer) RemoveMessageHandler(topic string, handler func([]byte)) {
	handlers, initialized := h.messageHandlers[topic]
	if initialized {
		h.messageHandlers[topic] = utils.Remove(handlers, handler)
	}
}

func parseMsgType(r *http.Request) string {
	return r.Header.Get("type")
}

// Init implements aggregate.Plugin.
func (h *HttpServer) Init() error {
	mux := http.NewServeMux()
	mux.Handle("GET "+string(peer.RouteKnownPeers), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peerId := r.Header.Get("peer_id")
		if peerId != "" {
			h.peers.AppendSingle(peer.Peer(peerId))
		}
		res, err := json.Marshal(h.peers)
		if err != nil {
			panic(err) // this should never happen, if it does it's a bug
		}
		w.Write(res)
	}))
	mux.Handle("POST "+string(peer.RouteSendMsg), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		msgType := parseMsgType(r)

		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(500)
			w.Write([]byte(err.Error()))
			return
		}

		if handlers, ok := h.messageHandlers[msgType]; ok {
			for _, handler := range handlers {
				go handler(body[:])
			}
		}

		w.WriteHeader(200)
	}))

	h.server = &http.Server{
		Addr:    h.config.Addr,
		Handler: mux,
	}

	return nil
}

// Start implements aggregate.Plugin.
func (h *HttpServer) Start() error {
	// TODO handle errors: i.e. port already in use
	go h.server.ListenAndServe()
	return nil
}

// Stop implements aggregate.Plugin.
func (h *HttpServer) Stop() error {
	return h.server.Close()
}
