package main

import (
	"fmt"
	"os"

	"github.com/vsc-eco/vsc-node/modules/aggregate"
	btcStreamer "github.com/vsc-eco/vsc-node/modules/bitcoin/streamer"
	"github.com/vsc-eco/vsc-node/modules/mongo"
)

func main() {
	db := mongo.New()
	a := aggregate.New(
		db,
		btcStreamer.New(db),
	)

	err := a.Run()
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
