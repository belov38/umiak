package desktop

import (
	"context"
	"errors"
	"time"
)

type serviceControl interface {
	Query() (uint32, error)
	Start() error
	Stop() error
}

func controlService(ctx context.Context, service serviceControl, action string) error {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	if e := ctx.Err(); e != nil {
		return e
	}
	if action == "restart" {
		if e := controlService(ctx, service, "stop"); e != nil {
			return e
		}
		action = "start"
	}
	target := uint32(4)
	if action == "stop" {
		target = 1
	} else if action != "start" {
		return errors.New("invalid service action")
	}
	for {
		state, e := service.Query()
		if e != nil {
			return e
		}
		if state == target {
			return nil
		}
		if action == "start" && state == 1 {
			if e = service.Start(); e != nil {
				return e
			}
		} else if action == "stop" && state == 4 {
			if e = service.Stop(); e != nil {
				return e
			}
		}
		if e = pause(ctx, 100*time.Millisecond); e != nil {
			return e
		}
	}
}
