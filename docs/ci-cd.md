# CH09-BRK CI/CD

This project uses a controlled CI/CD flow. Production deploys are manual by design.

## Workflows

- `CI` (`.github/workflows/ci.yml`): runs on pull requests and pushes to `main`.
  - `npm ci`
  - `npm run tsc`
  - Docker image build without push

- `Build and publish Docker image` (`.github/workflows/release.yml`): runs on pushes to `main` and manual dispatch.
  - Generates build metadata through `npm run tsc` / `pretsc`
  - Pushes both:
    - `dhzacur/ha_ch09_brk:<build-version>`
    - `dhzacur/ha_ch09_brk:latest`

- `Deploy CH09-BRK` (`.github/workflows/deploy.yml`): manual dispatch only.
  - Targets: `srisri`, `merclin`, `induart`, `all`
  - Requires a self-hosted runner with network access to the client hosts.
  - Recreates only the `ch09` service; certbot and unrelated containers are preserved.
  - Pulls the requested image tag, retags it locally as `dhzacur/ha_ch09_brk:latest`, then recreates `ch09` because existing compose files use the untagged image name.

## Required GitHub Secrets

Docker Hub:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

SSH deploy key:

- `CH09_DEPLOY_SSH_KEY`

SRI SRI broker host:

- `SRISRI_BROKER_HOST`
- `SRISRI_BROKER_USER`
- `SRISRI_BROKER_PORT` (optional; defaults to `22`)

Merclin broker host:

- `MERCLIN_BROKER_HOST`
- `MERCLIN_BROKER_USER`
- `MERCLIN_BROKER_PORT` (optional; defaults to `22`)

Induart physical host and ges01 VM:

- `INDUART_PHYSICAL_HOST`
- `INDUART_PHYSICAL_USER`
- `INDUART_PHYSICAL_PORT` (optional; defaults to `22`)
- `INDUART_GES01_HOST`
- `INDUART_GES01_USER`
- `INDUART_GES01_PORT` (optional; defaults to `22`)

Induart topology is intentionally a jump path:

```text
runner -> Induart physical host -> ges01
```

Do not deploy Induart by assuming `ges01` is directly reachable from the runner.

## Deployment paths

The deploy script expects these existing dockerzone paths:

- SRI SRI production: `/mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK`
- SRI SRI testing: `/mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK-Testing`
- Merclin production: `/mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK`
- Merclin testing: `/mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK_Testing`
- Induart production: `/opt/solinges/ecosystem/dockerzone/CH09-BRK`

## Manual deploy

1. Run `Build and publish Docker image`.
2. Copy the generated image tag from the summary, or use `latest` only after confirming the release completed.
3. Run `Deploy CH09-BRK` with the target and image tag.
4. Verify the broker endpoints:
   - `/foreign/broker/health`
   - `/foreign/broker/pool`
   - `/foreign/broker/pool/show`

The pool UI and JSON should show the build metadata and must not expose raw AGES token/cookie values.

## Watchtower auto-update mode

Current client hosts use Watchtower as the low-friction deployment path. A push to `main` publishes
`dhzacur/ha_ch09_brk:latest`; Watchtower polls Docker Hub and recreates only broker containers that
explicitly opt in.

Each broker `ch09` service must keep this label:

```yaml
labels:
  - "com.centurylinklabs.watchtower.enable=true"
```

Watchtower should run with label filtering enabled so certbot and unrelated containers are not touched:

```bash
docker run -d \
  --name watchtower \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e DOCKER_API_VERSION=1.44 \
  containrrr/watchtower \
  --label-enable --cleanup --interval 300
```

`DOCKER_API_VERSION=1.44` is intentional. Without it, this environment can make Watchtower detect an
old Docker client API and restart-loop with `client version 1.25 is too old`.

Watchtower is currently installed on:

- SRI SRI production and testing broker containers.
- Merclin production and testing broker containers.
- Induart production broker container through the physical host jump path.
