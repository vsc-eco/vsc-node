package main

import (
	"fmt"
	"os"

	"github.com/vsc-eco/vsc-node/modules/aggregate"
	hiveStreamer "github.com/vsc-eco/vsc-node/modules/hive/streamer"
	"github.com/vsc-eco/vsc-node/modules/mongo"
)

func main() {
	db := mongo.New()
	a := aggregate.New(
		db,
		hiveStreamer.New(db),
	)

	err := a.Run()
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
