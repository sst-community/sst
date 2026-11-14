package cli

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"

	"github.com/briandowns/spinner"
	"github.com/joho/godotenv"
	"github.com/sst/sst/v3/cmd/sst/mosaic/ui"
	"github.com/sst/sst/v3/internal/fs"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/pulumidev"
)

// the temp log what's logged goes to until InitProject makes sst.log
var tempLogPath string

var logFile = (func() *os.File {
	tmpPath := flag.SST_LOG
	if tmpPath == "" {
		tmpPath = filepath.Join(os.TempDir(), fmt.Sprintf("sst-%s.log", time.Now().Format("2006-01-02-15-04-05")))
		tempLogPath = tmpPath
	}
	logFile, err := os.Create(tmpPath)
	if err != nil {
		panic(err)
	}
	if flag.SST_LOG != "" {
		// what an earlier run's log moved there past its cap
		os.Remove(tmpPath + ".1")
	}
	return logFile
})()

func (c *Cli) Discover() (string, error) {
	cfgPath := c.String("config")
	if cfgPath != "" {
		abs, err := filepath.Abs(cfgPath)
		if err != nil {
			return "", util.NewReadableError(err, "Could not find "+cfgPath)
		}
		if _, err := os.Stat(abs); os.IsNotExist(err) {
			return "", util.NewReadableError(err, "Could not find "+abs)
		}
		if isPulumiProgram(abs) {
			return c.pulumiProgram(abs)
		}
		return abs, nil
	}

	match, err := project.Discover()
	if err != nil {
		// sst dev runs a plain Pulumi program too, in a folder with a
		// Pulumi.yaml and no SST app up from it (pulumi.go): only when there's
		// no sst.config.ts, not one that couldn't be used
		if runsPulumiPrograms() && !hasSSTConfig() {
			if found, findErr := pulumidev.Discover(); findErr == nil {
				return c.pulumiProgram(found)
			}
		}
		return "", util.NewReadableError(err, "Could not find sst.config.ts")
	}
	return match, nil
}

// hasSSTConfig is whether there's an sst.config.ts up from the working
// folder
func hasSSTConfig() bool {
	cwd, err := os.Getwd()
	if err != nil {
		return true
	}
	_, err = fs.FindUp(cwd, "sst.config.ts")
	return err == nil
}

// InitDev loads what sst dev runs: the SST app, or a plain Pulumi program
// (pulumi.go).
func (c *Cli) InitDev() (project.Program, error) {
	cfgPath, err := c.Discover()
	if err != nil {
		return nil, err
	}
	if isPulumiProgram(cfgPath) {
		return c.initPulumi(cfgPath)
	}
	p, err := c.InitProject()
	if err != nil {
		return nil, err
	}
	if p.App().Protect {
		return nil, project.ErrProtectedDevStage
	}
	return p, nil
}

func (c *Cli) InitProject() (*project.Project, error) {
	return c.initProject(true)
}

// InitProjectWithoutHome reads the project and its stage as InitProject
// does, and doesn't load its home: a stage's target isn't started.
func (c *Cli) InitProjectWithoutHome() (*project.Project, error) {
	return c.initProject(false)
}

func (c *Cli) initProject(loadHome bool) (*project.Project, error) {
	slog.Info("initializing project", "version", c.version)

	cfgPath, err := c.Discover()
	if err != nil {
		return nil, err
	}

	stage, err := c.Stage(cfgPath)
	if err != nil {
		return nil, util.NewReadableError(err, "Could not find stage")
	}

	p, err := project.New(&project.ProjectConfig{
		Version: c.version,
		Stage:   stage,
		Config:  cfgPath,
	})
	if err != nil {
		return nil, err
	}
	c.loaded(p.App().Stage, p.NodeVersion())
	godotenv.Load(filepath.Join(p.PathRoot(), ".env"))
	if err := c.logTo(p.PathLog("")); err != nil {
		return nil, err
	}

	spin := spinner.New(spinner.CharSets[14], 100*time.Millisecond, spinner.WithWriterFile(os.Stderr))
	spin.Color("cyan")
	defer spin.Stop()
	if !p.CheckPlatform(c.version) {
		spin.Suffix = "  Upgrading project..."
		spin.Start()
		err := p.CopyPlatform(c.version)
		if err != nil {
			return nil, util.NewReadableError(err, "Could not copy platform code to project directory")
		}
	}

	if p.NeedsInstall() {
		spin.Suffix = "  Installing providers..."
		spin.Start()
		err = p.Install()
		if err != nil {
			return nil, err
		}
	}

	if loadHome {
		if err := p.LoadHome(); err != nil {
			return nil, err
		}
		// What the CLI kept of its environment when it started, which sst
		// dev's panes and sst shell are given, as the stage's target gives it
		c.env = p.Target().Env(c.env)
	}

	app := p.App()
	slog.Info("loaded config", "app", app.Name, "stage", app.Stage)

	c.configureLog()
	return p, nil
}

// loaded does what's done for every project once it's read: what the
// processes the command starts read of it, and the checks of what it runs on
func (c *Cli) loaded(stage, nodeVersion string) {
	// Looks for a newer sst once a day, for the UI to say on a later run
	go global.CheckForUpdate(c.version)
	// Builds and the processes the command starts, like the one running the config's run(), read the stage from the environment
	os.Setenv("SST_STAGE", stage)
	if project.NodeTooOld(nodeVersion) {
		fmt.Fprintln(os.Stderr, ui.TEXT_WARNING_BOLD.Render("Warning: ")+fmt.Sprintf("SST needs Node.js %d or later, and this is Node.js %s. Some features may fail until you upgrade.", project.MinNodeMajor, nodeVersion))
	}
}

// logTo moves what's been logged so far to the project's sst.log, in logDir,
// and logs the rest there
func (c *Cli) logTo(logDir string) error {
	if flag.SST_LOG == "" {
		// what's logged meanwhile waits for the new file
		logMu.Lock()
		if _, err := logFile.Seek(0, 0); err != nil {
			logMu.Unlock()
			return err
		}
		sstLog := filepath.Join(logDir, "sst.log")
		os.MkdirAll(logDir, 0755)
		nextLogFile, err := os.Create(sstLog)
		if err != nil {
			logMu.Unlock()
			return util.NewReadableError(err, "Could not create log file")
		}
		// what an earlier run's log moved there past its cap
		os.Remove(sstLog + ".1")
		_, err = io.Copy(nextLogFile, logFile)
		if err != nil {
			logMu.Unlock()
			return util.NewReadableError(err, "Could not copy log file")
		}
		logFile.Close()
		// its name is taken now, as logFile can change once it's unlocked
		tmpLog := logFile.Name()
		defer func() {
			// only the temp log, not an sst.log a second call would have here
			if tmpLog != tempLogPath {
				return
			}
			if err := os.Remove(tmpLog); err != nil {
				slog.Error("failed to remove temp log file", "err", err)
			}
			// were it ever past the cap before sst.log
			os.Remove(tmpLog + ".1")
		}()
		logFile = nextLogFile
		logMu.Unlock()
	}
	// before the temp log is removed: the crash output holds it open until
	// it's moved to the new file, and Windows can't remove an open file
	c.configureLog()
	return nil
}

func (c *Cli) configureLog() {
	writer := logWriters{cappedLog{}}
	if c.Bool("print-logs") || flag.SST_PRINT_LOGS {
		writer = append(writer, os.Stderr)
	}
	slog.SetDefault(
		slog.New(slog.NewTextHandler(writer, &slog.HandlerOptions{
			Level: slog.LevelInfo,
		})),
	)
	logMu.Lock()
	debug.SetCrashOutput(logFile, debug.CrashOptions{})
	logMu.Unlock()
}
