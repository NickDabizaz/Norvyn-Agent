# VPS Deployment

Norvyn v1 is a local-first, single-user application and is not deployed to a VPS or exposed as a hosted
service.

## Why this is out of scope

The application can read and modify a local Workspace by driving a Provider through its Local Session. Its
loopback binding and per-run token are designed to protect that local capability, not to authenticate remote
users over a public or shared network. Deploying the current runtime to a VPS would therefore change the
product boundary and require a separate identity, authorization, credential, storage, and network-security
design.

Continuous integration or npm release automation may still be introduced in a separate issue; only remote
deployment is rejected here.

## Prior requests

- #22 — "Set up CI/CD pipeline (GitHub Actions): lint/typecheck/test on PR, build+push+deploy on main"
