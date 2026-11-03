package main

import (
	"fmt"
	"regexp"

	"dagger/lamplit-app/internal/dagger"
)

type LamplitApp struct{}

// Build creates both archives from one verified build.
func (m *LamplitApp) Build(
	// +ignore=["*", "!package.json", "!bun.lock", "!tsconfig.json", "!LICENSE", "!apps/web/**", "!packages/contracts/**", "!scripts/**", "!tests/**", "!docs/IMPORTS.md", "!docs/licenses/**", "**/node_modules", "**/build", "**/dist", "**/.env*", "**/.npmrc", "apps/web/src/lib/paraglide/**", "apps/web/project.inlang/**", "!apps/web/project.inlang/settings.json"]
	source *dagger.Directory, revision string,
) (*dagger.Directory, error) {
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(revision) {
		return nil, fmt.Errorf("a full lowercase commit SHA is required")
	}
	archive := "lamplit-app-" + revision + ".tar.gz"
	contracts := "lamplit-contracts-" + revision + ".tar.gz"
	node := dag.Container(dagger.ContainerOpts{Platform: dagger.Platform("linux/amd64")}).
		From("node:24.18.1-bookworm@sha256:19cd848a0e073d34bd8cd5545a1b6b4d28489b3e3b607366621ced442bd5f6b4")
	build := dag.Container(dagger.ContainerOpts{Platform: dagger.Platform("linux/amd64")}).
		From("oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4").
		WithFile("/usr/local/bin/node", node.File("/usr/local/bin/node")).
		WithDirectory("/usr/local/lib/node_modules/npm", node.Directory("/usr/local/lib/node_modules/npm")).
		WithExec([]string{"ln", "-sf", "/usr/local/lib/node_modules/npm/bin/npm-cli.js", "/usr/local/bin/npm"}).
		WithWorkdir("/build").WithDirectory("/build", source).
		WithMountedCache("/bun-cache", dag.CacheVolume("lamplit-app-bun-1.3.14-linux-amd64-v1"), dagger.ContainerWithMountedCacheOpts{Sharing: dagger.CacheSharingModeLocked}).
		WithEnvVariable("BUN_INSTALL_CACHE_DIR", "/bun-cache").
		WithEnvVariable("CI", "true").
		WithExec([]string{"bun", "install", "--frozen-lockfile"}).
		WithExec([]string{"bun", "run", "check"}).
		WithExec([]string{"bun", "run", "test"}).
		WithExec([]string{"bun", "run", "build"}).
		WithExec([]string{"bun", "scripts/package-frontend.mjs", revision, archive, contracts})
	return dag.Directory().WithFile(archive, build.File("/build/" + archive)).WithFile(contracts, build.File("/build/" + contracts)), nil
}
