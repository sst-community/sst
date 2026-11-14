package provider

import (
	"encoding/json"
	"io"
)

type DevTransport struct {
	In  chan string
	Out chan string
}

type Provider interface {
	Init(app string, stage string, args map[string]interface{}) error
	Env() (map[string]string, error)
}

type DevEvent struct {
	*io.PipeReader
}

func (dt *DevTransport) Publish(input interface{}) error {
	jsonBytes, err := json.Marshal(input)
	if err != nil {
		return err
	}
	dt.Out <- string(jsonBytes)
	return nil
}

type DevSession interface {
	Cleanup() error
	Publish(json string) error
}

const SSM_NAME_BOOTSTRAP = "/sst/bootstrap"
