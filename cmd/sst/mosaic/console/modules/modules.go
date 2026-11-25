// Package modules is the list of the console's modules.
//
// A module is a package of its own, like the ones here: a type that
// implements console.Module, and its part of the page in a web folder it
// embeds. To add one, write its package and add it to All. See the console's
// README.md.
package modules

import (
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console/modules/deploy"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console/modules/host"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console/modules/invocations"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console/modules/logs"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console/modules/stats"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console/modules/workers"
)

// All is every module, in the order of their tabs.
var All = []console.Module{
	logs.Module{},
	invocations.Module{},
	deploy.Module{},
	stats.Module{},
	workers.Module{},
	host.Module{},
}
