package utils

import (
	"time"

	"github.com/chebyrash/promise"
)

func Sleep(ts time.Duration) *promise.Promise[struct{}] {
	return promise.New(func(resolve func(struct{}), reject func(error)) {
		time.AfterFunc(ts, func() {
			resolve(struct{}{})
		})
	})
}
