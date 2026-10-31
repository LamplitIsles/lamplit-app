package main

import (
	"fmt"
	"regexp"

	"dagger/lamplit-app/internal/dagger"
)

type LamplitApp struct{}

// Build creates the frontend archive once from the verified source revision.
func (m *LamplitApp) Build(
	// +ignore=["*", "!package.json", "!bun.lock", "!tsconfig.json", "!LICENSE", "!apps/web/**", "!packages/contracts/**", "!scripts/package-frontend.mjs", "!scripts/publish-frontend.mjs", "!tests/frontend-artifact.test.mjs", "!docs/IMPORTS.md", "!docs/licenses/**", "**/node_modules", "**/build", "**/dist", "**/.env*", "**/.npmrc", "apps/web/src/lib/paraglide/**", "apps/web/project.inlang/**", "!apps/web/project.inlang/settings.json"]
	source *dagger.Directory, revision string,
) (*dagger.File, error) {
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(revision) {
		return nil, fmt.Errorf("a full lowercase commit SHA is required")
	}
	archive := "lamplit-app-" + revision + ".tar.gz"
	build := dag.Container(dagger.ContainerOpts{Platform: dagger.Platform("linux/amd64")}).
		From("oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4").
		WithWorkdir("/build").WithDirectory("/build", source).
		WithMountedCache("/bun-cache", dag.CacheVolume("lamplit-app-bun-1.3.14-linux-amd64-v1"), dagger.ContainerWithMountedCacheOpts{Sharing: dagger.CacheSharingModeLocked}).
		WithEnvVariable("BUN_INSTALL_CACHE_DIR", "/bun-cache").
		WithEnvVariable("CI", "true").
		WithExec([]string{"bun", "test", "tests/frontend-artifact.test.mjs"}).
		WithExec([]string{"bun", "install", "--frozen-lockfile"}).
		WithExec([]string{"bun", "run", "build"}).
		WithExec([]string{"bun", "scripts/package-frontend.mjs", revision, archive})
	return build.File("/build/" + archive), nil
}
