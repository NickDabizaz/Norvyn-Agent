# Releasing Norvyn

Norvyn releases are built by GitHub Actions and published to npm with provenance. Maintainers should not
publish from a workstation.

## One-time npm setup

1. Create the public `norvyn` package on npm, if it does not exist yet.
2. In the package's npm access settings, add a GitHub Actions trusted publisher for `NickDabizaz/Norvyn-Agent`
   using `.github/workflows/release.yml`.
3. In the GitHub repository, create an environment named `npm`. Keep deployment protection enabled if releases
   require maintainer approval.
4. Confirm GitHub Pages uses **GitHub Actions** as its source.

No long-lived npm token is required. The release workflow uses npm trusted publishing and GitHub's short-lived
OpenID Connect identity.

## Publish a release

1. Run the full local verification with `npm run verify`.
2. Push the reviewed commit to `master`.
3. Open **Actions → Publish npm package → Run workflow** and enter the exact semantic version to publish, such
   as `0.2.0`.
4. Approve the `npm` environment deployment when prompted.

The workflow verifies that the requested version matches `package.json`, runs the complete test suite, packs
and smoke-tests the package, publishes it with provenance, creates the matching Git tag, and creates a GitHub
release.

If any verification step fails, the workflow stops before publishing. If npm publishing succeeds but GitHub
Release creation is interrupted, rerun the same workflow and version; the publish and release steps are
idempotent and resume from the missing artifact.
