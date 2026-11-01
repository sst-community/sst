package project

import (
	"encoding/json"
	"fmt"
)

// ContractVersion is the version of the program contract the core speaks: what
// it gives the program, and the newest report it reads. The platform's side
// is platform/src/components/contract.ts.
const ContractVersion = 1

// Report is what a component told the core through the program contract. A
// component's record is its _sst output. The 4.x components name each item
// as an output of its own (_metadata, _dev, _task, _tunnel, _hint), which the
// core reads the same way until they go.
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

// The output 4.x's components give each item of a report as
var legacyOutputs = map[string]string{
	"_metadata": "function",
	"_dev":      "dev",
	"_task":     "task",
	"_tunnel":   "tunnel",
	"_hint":     "hint",
}

// ErrNewerContract is returned for a record written by a newer platform than
// this CLI's, which it can't read.
type ErrNewerContract struct {
	Version int
}

func (e *ErrNewerContract) Error() string {
	return fmt.Sprintf("This stage was deployed by a newer version of SST: its components report in version %d of the program contract, and this CLI reads up to version %d. Upgrade SST.", e.Version, ContractVersion)
}

// readReport reads what a component reported from its outputs, already
// decrypted. It's nil when it reported nothing. A field of the wrong type is
// left out, and the rest is read, as the core always has.
func readReport(outputs map[string]interface{}) (*Report, error) {
	if record, ok := outputs["_sst"].(map[string]interface{}); ok {
		report := decode[Report](record)
		if report.Contract > ContractVersion {
			return nil, &ErrNewerContract{Version: report.Contract}
		}
		return report, nil
	}
	legacy := map[string]interface{}{}
	for output, item := range legacyOutputs {
		value := outputs[output]
		object, isObject := value.(map[string]interface{})
		_, isString := value.(string)
		switch {
		case item == "hint" && isString:
			legacy[item] = value
		// A 4.x site names what it is as _metadata too, with no handler: it
		// isn't a function
		case item == "function" && isObject:
			if _, ok := object["handler"].(string); ok {
				legacy[item] = value
			}
		case item != "hint" && item != "function" && isObject:
			legacy[item] = value
		}
	}
	if len(legacy) == 0 {
		return nil, nil
	}
	return decode[Report](legacy), nil
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
