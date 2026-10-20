package global

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/sst/sst/v3/pkg/npm"
)

func Upgrade(existingVersion string, nextVersion string) (string, error) {
	var filename string
	switch runtime.GOOS {
	case "darwin":
		filename = "mac-"
	case "windows":
		filename = "windows-"
	default:
		filename = "linux-"
	}

	switch runtime.GOARCH {
	case "amd64":
		filename += "x86_64.tar.gz"
	case "arm64":
		filename += "arm64.tar.gz"
	case "386":
		filename += "i386.tar.gz"
	default:
		return "", fmt.Errorf("unsupported architecture")
	}
	if nextVersion == "" {
		next, err := newestRelease(existingVersion)
		if err != nil {
			return "", err
		}
		nextVersion = next
	}
	if !strings.HasPrefix(nextVersion, "v") {
		nextVersion = "v" + nextVersion
	}
	if !strings.HasPrefix(existingVersion, "v") {
		existingVersion = "v" + existingVersion
	}
	if nextVersion == existingVersion {
		return nextVersion, nil
	}
	url := "https://github.com/" + ReleaseRepo + "/releases/download/" + nextVersion + "/sst-" + filename
	slog.Info("downloading", "url", url)
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected HTTP status when downloading release: %s", resp.Status)
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	sstBinPath := filepath.Join(homeDir, ".sst", "bin")
	os.RemoveAll(sstBinPath)
	if err := os.MkdirAll(sstBinPath, os.ModePerm); err != nil {
		return "", err
	}

	// Assuming we have a variable `resp` which is the response from a *http.Request
	body, err := gzip.NewReader(resp.Body)
	if err != nil {
		return "", err
	}
	defer body.Close()

	if err := untar(body, sstBinPath); err != nil {
		return "", err
	}

	if err := os.Chmod(filepath.Join(sstBinPath, "sst"), 0755); err != nil {
		return "", err
	}

	return nextVersion, nil
}

var githubAPI = "https://api.github.com"

// The newest release in the same major version as the one installed. A build
// that isn't a release gets the latest release.
func newestRelease(existingVersion string) (string, error) {
	get := func(path string, into any) error {
		resp, err := http.Get(githubAPI + "/repos/" + ReleaseRepo + path)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("unexpected HTTP status when finding the release: %s", resp.Status)
		}
		return json.NewDecoder(resp.Body).Decode(into)
	}

	if npm.IsRelease(existingVersion) {
		// Every page, so a major older than the newest 100 releases is found
		tags := []string{}
		for page := 1; ; page++ {
			var releases []struct {
				TagName string `json:"tag_name"`
				Draft   bool   `json:"draft"`
			}
			if err := get(fmt.Sprintf("/releases?per_page=100&page=%d", page), &releases); err != nil {
				return "", err
			}
			for _, release := range releases {
				if !release.Draft {
					tags = append(tags, release.TagName)
				}
			}
			if len(releases) < 100 {
				break
			}
		}
		newest, ok, err := npm.NewestInMajor(existingVersion, tags)
		if ok {
			return newest, err
		}
	}

	var latest struct {
		TagName string `json:"tag_name"`
	}
	if err := get("/releases/latest", &latest); err != nil {
		return "", err
	}
	return latest.TagName, nil
}

func UpgradeNode(existingVersion string, nextVersion string) (map[string]string, error) {
	result := make(map[string]string)
	if nextVersion == "" {
		next, err := npm.Newest(npm.LoadRegistry(), NPMPackage, existingVersion)
		if err != nil {
			return result, err
		}
		nextVersion = next
	}

	files, err := filepath.Glob("**/*/package.json")
	files = append(files, "package.json")
	if err != nil {
		return result, err
	}

	// Ensure we only replace an existing "sst" entry in dependencies/devDependencies of package.json
	re := regexp.MustCompile(`(("dependencies"|"devDependencies")\s*:\s*{[^}]*"sst"\s*:\s*)"[^"]*"`)
	for _, file := range files {
		if strings.HasPrefix(file, ".sst") {
			continue
		}
		if strings.Contains(file, "node_modules") {
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		matches := re.FindAll(data, -1)
		if len(matches) == 0 {
			continue
		}
		data = re.ReplaceAll(data, []byte(`${1}"`+NPMSpec(nextVersion)+`"`))
		err = os.WriteFile(file, data, 0666)
		if err != nil {
			return result, err
		}
		result[file] = nextVersion
	}
	return result, nil
}

func untar(reader io.Reader, target string) error {
	tarReader := tar.NewReader(reader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break // End of tarball
		}
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(filepath.Join(target, header.Name), 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			outPath := filepath.Join(target, filepath.Base(header.Name))
			outFile, err := os.Create(outPath)
			if err != nil {
				return err
			}
			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return err
			}
			outFile.Close()

			err = os.Chmod(outPath, 0755)
			if err != nil {
				return err
			}

		}
	}
	return nil
}
