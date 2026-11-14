package project

import (
	"encoding/json"
	"fmt"
)

// ContractVersion is the version of the program contract the core speaks: what
// it gives the program, and the newest report it reads. The platform's side
// is platform/src/components/contract.ts.
const ContractVersion = 1

// Report is what a component told the core through the program contract: its
// record, the _sst output. SST 4's components named each item as an output
// of its own (_metadata, _dev, _task, _tunnel, _hint), which only SST 4's
// contract reads (pkg/sst4).
type Report struct {
	Contract int             `json:"contract"`
	Function *FunctionReport `json:"function,omitempty"`
	Dev      *Dev            `json:"dev,omitempty"`
	Task     *Task           `json:"task,omitempty"`
	Tunnel   *Tunnel         `json:"tunnel,omitempty"`
	Hint     string          `json:"hint,omitempty"`
}

// FunctionReport is a function the core builds, and in sst dev runs locally.
type FunctionReport struct {
	Handler  string `json:"handler"`
	Internal bool   `json:"internal,omitempty"`
	Dev      bool   `json:"dev,omitempty"`
}

// ErrNewerContract is returned for a record written by a newer platform than
// this CLI's, which it can't read.
type ErrNewerContract struct {
	Version int
}

func (e *ErrNewerContract) Error() string {
	return fmt.Sprintf("This stage was deployed by a newer version of SST: its components report in version %d of the program contract, and this CLI reads up to version %d. Upgrade SST.", e.Version, ContractVersion)
}

// ReadReport reads what a component reported from its outputs, already
// decrypted. It's nil when it reported nothing. A field of the wrong type is
// left out, and the rest is read, as the core always has. SST 4's contract
// (pkg/sst4) reads it too, so a component can report this way on either line.
func ReadReport(outputs map[string]interface{}) (*Report, error) {
	record, ok := outputs["_sst"].(map[string]interface{})
	if !ok {
		return nil, nil
	}
	report := decode[Report](record)
	if report.Contract > ContractVersion {
		return nil, &ErrNewerContract{Version: report.Contract}
	}
	return report, nil
}

// decode reads value into a T as json.Unmarshal does, which leaves out a
// field of the wrong type and reads the rest
func decode[T any](value interface{}) *T {
	var result T
	if data, err := json.Marshal(value); err == nil {
		json.Unmarshal(data, &result)
	}
	return &result
}
