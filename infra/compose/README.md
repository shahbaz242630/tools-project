# Deployment

How a commit becomes a running process, and how to undo it.

Everything here follows [ADR 0009](../../adr/0009-self-hosted-vps-with-off-box-backups.md) (one self-hosted KVM VPS, staging and production sharing it), [ADR 0012](../../adr/0012-immutable-image-tags-and-compose-deploys.md) (immutable image tags, the box never builds) and [ADR 0037](../../adr/0037-managed-postgres-with-self-hosted-applications.md) (**the database is not on this box** — it is managed on Neon).

> **Used for real on 9 August 2026**, on a Hetzner CX23 against Neon, and corrected where it was wrong — which was the point of writing it down. What it produced: `web`, `api`, `worker` and Redis healthy, no Postgres container, no published ports, `/ready` reporting `postgres: ok`.
>
> **Still unexercised:** the ingress. It has never run, and it is expected to be the wrong shape — it listens for inbound traffic, and Cloudflare's Tunnel makes an outbound-only connection instead. Until a domain exists the ingress stays down deliberately, because bringing it up would put plain HTTP on a dialable public IP, which BRD §10.2 forbids. Reach the stack over an SSH tunnel meanwhile:
>
> ```sh
> # The container name resolves inside the compose network and NOT on the host,
> # so the forward has to name the container's address. It changes when the
> # container is recreated, which a deploy does every time.
> ssh deploy@<box> "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' rental-staging-web"
> ssh -N -L 3000:<that address>:3000 deploy@<box>   # then http://localhost:3000
> ```

## What is here

| File                         | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `docker-compose.app.yml`     | One environment: web, API, worker, Redis. Two copies can run.          |
| `docker-compose.ingress.yml` | The shared edge. One per box, holds ports 80/443 and the certificates. |
| `Caddyfile`                  | TLS and hostname routing for both environments.                        |
| `app.env.example`            | Template for `/opt/rental/<env>.env`.                                  |
| `ingress.env.example`        | Template for `/opt/rental/ingress.env`.                                |

The repository root's `docker-compose.yml` is the **local development** stack and is unrelated to any of this.

### The database is somewhere else

`docker-compose.app.yml` does contain a `postgres` service, and **it is not part of any environment.** It sits behind the `rehearsal` compose profile so that the `Deploy rehearsal` CI job can drive this exact file end to end on every pull request without reaching a live managed database. Nothing on the box enables that profile, and `deploy.mjs` refuses to run with it enabled against production. See [ADR 0039](../../adr/0039-the-deployment-stack-carries-a-database-it-never-runs.md).

Two consequences for anyone operating this:

- **There is no `rental-<env>-postgres` container.** Reach the database through the Neon console or `psql` against its endpoint, not through `docker exec`.
- **Two hostnames, differing by six characters.** `POSTGRES_HOST` is Neon's `-pooler` endpoint and is what the API and worker use; `POSTGRES_DIRECT_HOST` is the same host without it and is used by migrations alone, because Prisma's advisory lock does not survive a transaction pooler.

## Provisioning a fresh box

One time, as root, on a clean Ubuntu KVM VPS.

**1. A non-root user that can drive Docker.**

```sh
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

**2. Docker, and Node.**

Node is not optional and is easy to miss: `scripts/deploy.mjs` and
`scripts/logs.mjs` are Node scripts, and they are the only supported way to
change what is running. The first real provisioning got as far as the deploy
command before discovering it.

Ubuntu's own package is fine — no version manager on a box that runs four
containers. 24.04 and later carry Node 22, which is what `.nvmrc` pins.

```sh
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

apt-get update && apt-get install -y nodejs
node --version   # expect v22.x
```

**3. Close everything except SSH and HTTP(S).**

Redis publishes no ports, so it is already unreachable — this is the second layer, not the first. Postgres is not on this box at all (ADR 0037), so the box's firewall is not what protects it; Neon's own access controls are.

```sh
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443
ufw --force enable
```

**4. Refuse SSH passwords.**

```sh
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
```

**5. Unattended security updates.**

```sh
apt-get update && apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Everything from here on is as `deploy`, not root.

**6. The repository.**

The box needs it for the compose files and `infra/postgres/init`. It never builds from it.

```sh
sudo mkdir -p /opt/rental && sudo chown deploy:deploy /opt/rental
git clone https://github.com/shahbaz242630/tools-project.git /opt/rental/repo
```

**7. The shared network.**

Created here rather than by a compose project, because a network owned by one project disappears when that project is torn down — taking the other environment's routing with it.

```sh
docker network create rental-edge
```

**8. Environment files.**

```sh
cd /opt/rental
cp repo/infra/compose/ingress.env.example ingress.env
cp repo/infra/compose/app.env.example staging.env
cp repo/infra/compose/app.env.example production.env
chmod 600 ingress.env staging.env production.env
```

Then edit each one, setting `APP_ENV` to match the filename.

**The database password is not generated here.** It used to be, when Postgres was
a container in this stack. Since ADR 0037 it is **issued by Neon** and the
console is the only place it can be read — Connect, or Branches → _branch_ →
Roles → Reset password. Staging and production are separate Neon projects with
separate credentials; sharing one means a staging deploy migrating production.

`PERSONAL_DATA_ENCRYPTION_KEY` **is** generated here, per environment, and is the
one value that cannot be reissued:

```sh
openssl rand -base64 32
```

`INTERNAL_TRIGGER_SECRET` is generated the same way, per environment (slice 4.7a,
ADR 0048). It is the shared secret the **worker** presents when it sets off
scheduled work and the **api** checks, so both services read the one value from
this file and they must agree.

Unlike the key above it **can** be reissued freely — nothing is encrypted with it
and no stored data depends on it. Rotating it means restarting both services
together; there is deliberately no support for two valid secrets at once, because a
rotation window is a second code path nobody would ever exercise.

Both services **refuse to start** without it, which is why it is generated here
rather than left for the first failed deploy to discover.

Leave `IMAGE_TAG` empty. The deploy script fills it in.

**Getting values into this file from a Windows machine is where secrets get
corrupted silently.** Two ways, both found the hard way:

- Python's `print` on Windows emits CRLF, so every value arrives with a trailing
  carriage return — a 32-byte key becomes 33 and fails at decrypt time.
- PowerShell piping to a native executable prepends a UTF-8 BOM, which makes the
  key name unmatchable, so the value is appended as a _second_ key while the real
  one stays empty. Compose reads the empty one.

Neither is visible in the file. If you must transfer values programmatically,
**base64-encode them and read stdin as bytes on this end**; `chmod 600` the file
afterwards and verify with `grep -c $'\xef\xbb\xbf'` returning zero.

**9. The CI deploy key.**

Only needed once CI should deploy rather than a human. The key is restricted to a forced command so it cannot open a shell, forward a port, or read a credential — `deploy` is in the `docker` group, which is root-equivalent, so an unrestricted key here would be indistinguishable from handing out root. See [ADR 0040](../../adr/0040-the-ci-deploy-key-cannot-open-a-shell.md).

Generate a key **that is not the one you log in with**, on your own machine:

```sh
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy-staging" -f ci_deploy
```

Install the wrapper and the restricted key on the box, as `deploy`:

```sh
cp /opt/rental/repo/infra/compose/ci-command.sh /opt/rental/ci-command.sh
chmod 755 /opt/rental/ci-command.sh
printf 'command="/opt/rental/ci-command.sh",restrict %s
' "$(cat ci_deploy.pub)"   >> /home/deploy/.ssh/authorized_keys
```

**Reinstall the wrapper whenever it changes in the repository** — nothing does it automatically, and that is deliberate: a mechanism that let CI update the thing constraining CI would defeat itself.

Pin the host key from the box rather than with `ssh-keyscan`, which trusts whatever answers:

```sh
ssh deploy@<box> cat /etc/ssh/ssh_host_ed25519_key.pub   | awk '{print "<box-ip> " $1 " " $2}' > known_hosts
```

Then set three secrets on the repository's `staging` **environment** — not repository-wide, so a workflow added later cannot reach them:

```sh
gh secret set STAGING_SSH_KEY     --env staging < ci_deploy
gh secret set STAGING_KNOWN_HOSTS --env staging < known_hosts
printf 'deploy@<box-ip>' | gh secret set STAGING_SSH_TARGET --env staging
```

Delete the local private key afterwards. Check the restriction actually bites before trusting it:

```sh
ssh -i ci_deploy deploy@<box> status                    # works
ssh -i ci_deploy deploy@<box> 'cat /opt/rental/staging.env'   # must be refused
ssh -i ci_deploy deploy@<box>                           # must refuse a shell
```

**10. DNS.**

Point both hostnames at the box's IPv4 address with A records, and wait for them to resolve. Caddy obtains certificates on first request, and it cannot do that before DNS is live.

```sh
dig +short app.example.com
dig +short staging.example.com
```

**11. Bring up the edge.**

```sh
cd /opt/rental/repo/infra/compose
docker compose --env-file /opt/rental/ingress.env -f docker-compose.ingress.yml up -d
```

It will return 502 for both hostnames until an environment is deployed. That is correct — it means TLS and routing work and there is nothing behind them yet.

## Deploying

From the repository on the box:

```sh
cd /opt/rental/repo
git pull                     # compose files and init SQL, not application code
node scripts/deploy.mjs --env staging --tag $(git rev-parse origin/main)
```

The tag is a full 40-character commit SHA. There is no `latest` — [ADR 0012](../../adr/0012-immutable-image-tags-and-compose-deploys.md) explains why, and the Release workflow prints the exact command in its run summary.

The script brings the stack up, polls `/ready` until it passes, and **reverts to the previous release automatically if it does not**. A deploy that reports success has served a readiness check.

## Rolling back

```sh
node scripts/deploy.mjs --env production --rollback
```

Returns to the release before the current one. Run it again to go back further — each rollback drops the abandoned release from the history rather than swapping between two.

To see where it would go before running it:

```sh
node scripts/deploy.mjs --env production --status
```

## Reading logs

```sh
node scripts/logs.mjs --env production --service api --since 15m
node scripts/logs.mjs --env production --since 2h --tail all --out incident.log
node scripts/logs.mjs --env ingress --since 30m          # 502s and TLS problems
node scripts/logs.mjs --env staging --follow
```

Retention is what the json-file driver holds: three files of 10 MB per service, set in the compose files. Enough for a recent incident, not an audit trail.

`--since` is validated rather than passed through, because Docker silently ignores a value it does not understand and returns the entire log — which reads exactly like a quiet incident window.

## The env file is not a shell script — never source it

`/opt/rental/<env>.env` is read by **Docker Compose**, which takes everything
after the first `=` as a literal value. It is not shell, and `source`ing it or
`. `-ing it is wrong in two ways.

**It does not work.** `CLERK_JWT_PUBLIC_KEY` is a PEM on one line, so its value
contains spaces — bash reads `CLERK_JWT_PUBLIC_KEY=-----BEGIN` as an assignment
and then tries to run `PUBLIC` as a command. You get
`line 117: PUBLIC: command not found`, which looks like a corrupt file and is
not one. Everything before and after still loads, so you end up with a
_partially_ populated shell and no indication of it — which is the worse half.

**And it is arbitrary code execution.** These values come from providers and
from `openssl rand`. A secret containing `$(…)` or a backtick runs on this box
the moment somebody sources the file. Nothing in this repository does it;
`deploy.mjs` passes the path to `docker compose --env-file` and rewrites
`IMAGE_TAG` as text.

To read one value, ask for that one value:

```sh
# One variable, no shell interpretation, no partial environment.
value() { sed -n "s/^$1=//p" /opt/rental/production.env; }

value POSTGRES_DIRECT_HOST
```

## Other things you will want

```sh
# A psql shell. There is no Postgres container — the database is on Neon
# (ADR 0037) — and **there is no psql on this box either**, deliberately: the
# host carries Docker and Node and nothing else it does not need. Run the
# client in a container.
#
# Use the DIRECT host for anything holding a session-level lock or issuing DDL;
# the pooler will drop it. `value` is defined in the section above — the env
# file must not be sourced.
docker run --rm -it -e PGPASSWORD="$(value POSTGRES_PASSWORD)" postgres:17-alpine \
  psql -h "$(value POSTGRES_DIRECT_HOST)" -p "$(value POSTGRES_PORT)" \
       -U "$(value POSTGRES_USER)" -d "$(value POSTGRES_DB)"

# When did the current release start?
docker inspect rental-production-api --format '{{.State.StartedAt}}'

# Reclaim space. Tagged images are rollback targets — this removes only
# untagged layers.
docker image prune -f
```

## Watching it

> **Run for real on 14 August 2026** (slice H5), against the staging app stack,
> and corrected where it was wrong. Prometheus scrapes the API (`health: up`),
> Promtail ships every container's logs into Loki, and Grafana serves both over
> an SSH tunnel. Proved by _firing_ it rather than by reading a status: the
> series for `/public/listings` did not exist, five real searches were made, and
> it read `5`.
>
> **Measured cost: ~219 MB** for all four containers — Grafana 115, Loki 53,
> Promtail 28, Prometheus 23 — on a box with 2.8 GB available. The worry about a
> box too small to run this was misplaced at our size, and it is no longer
> described as optional.

Metrics, dashboards and searchable logs. A separate compose file, so that
running it stays a deployment choice rather than an edit.

```bash
# Needs GRAFANA_ADMIN_PASSWORD and APP_ENV in the env file. Grafana refuses to
# start without a password rather than booting with a default; Prometheus needs
# APP_ENV to label which environment it is.
docker compose --env-file /opt/rental/<env>.env \
  -f docker-compose.app.yml -f docker-compose.observability.yml up -d
```

**The env file is not optional and the app stack must already be up.** This file
joins the network the app stack created — `rental-<env>_internal`, which is the
compose _project_ name plus `_internal`. That was wrong in this repository until
the first real run: it read `rental-<env>-app_internal`, and compose refuses to
start against a network that does not exist. Check with `docker network ls`
rather than reading it off a filename.

**Nothing here is published to the internet.** Prometheus scrapes the API over
the internal network — the same reachability the API has to Postgres, which is
why `/metrics` needs no credential. Grafana binds to `127.0.0.1` only, so it is
reached through an SSH tunnel:

```bash
# Local 3010, not 3010→3000 by accident: the *left* number is yours to choose,
# and 3000 is already the local web dev server (and, on this project owner's
# machine, another project entirely). Binding it here is how you end up reading
# a dashboard that is actually a Next.js 404.
ssh -N -L 3010:127.0.0.1:3000 <user>@<box>
# then open http://localhost:3010
```

What it gives you: request rate, error rate and latency by route; database and
queue timings; Node's event-loop lag, heap and GC. Between them they answer
"is it up", "is it slow", and "is it slow because of us or because of Postgres" —
which the logs alone cannot.

**Two settings need revisiting before real users exist.** Loki keeps logs for
14 days, and application logs carry IP addresses and user ids, so §10.1's
retention schedule reaches them in a way it does not reach metrics (which carry
no identifiers by construction — see `normaliseRoute`). And there are no alert
rules yet: this makes the platform _observable_, not _monitored_. Nothing will
wake anybody up.

**One more thing the first run taught, and it is the kind that hides.** Metrics
live in the API process, so **every deploy resets them** — and every merge to
`main` deploys. Before Prometheus existed, the counters were wiped several times
a day and nobody could have noticed; the exposition on a freshly deployed
container holds `/health` and nothing else. Prometheus is what makes a number
outlive a release, which is most of the argument for running it at all.

**And `environment` is expanded by Prometheus, not by compose.** A mounted config
file is opaque to compose, so `${APP_ENV}` in `prometheus.yml` needs
`--enable-feature=expand-external-labels` _and_ `APP_ENV` in the container's
environment. Both are set now; either alone leaves the label empty. It cannot be
checked by querying a series — external labels are attached on the way out, so
`/api/v1/status/config` is the only place they show.

## Not done yet

**The restore has never been drilled.** ADR 0009 called off-box database backups non-negotiable; ADR 0037 discharged that by moving the database to Neon, which takes them for us. What is still owed is proving a restore works, and noting that the **free tier's restore window is only six hours** — it must move to Launch before anything irreplaceable is stored. Until that drill has been run, treat both databases as recreatable from scratch.

**Deploys are not zero-downtime.** The API container stops before its replacement starts — a gap of a few seconds.

**Nothing ships logs off the box.** If the disk is lost, so is every log.

**No monitoring or alerting.** A stack that falls over at 3am stays down until somebody looks.
