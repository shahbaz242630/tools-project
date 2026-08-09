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

**9. DNS.**

Point both hostnames at the box's IPv4 address with A records, and wait for them to resolve. Caddy obtains certificates on first request, and it cannot do that before DNS is live.

```sh
dig +short app.example.com
dig +short staging.example.com
```

**10. Bring up the edge.**

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

## Other things you will want

```sh
# A psql shell. There is no Postgres container — the database is on Neon
# (ADR 0037). Connect to its endpoint directly, with the credentials from
# /opt/rental/production.env. Use the DIRECT host for anything holding a
# session-level lock; the pooler will drop it.
psql "postgresql://$POSTGRES_USER@$POSTGRES_DIRECT_HOST/$POSTGRES_DB?sslmode=verify-full"

# When did the current release start?
docker inspect rental-production-api --format '{{.State.StartedAt}}'

# Reclaim space. Tagged images are rollback targets — this removes only
# untagged layers.
docker image prune -f
```

## Watching it (optional)

Metrics, dashboards and searchable logs. A separate compose file, because a box
too small to run both should run the marketplace rather than the monitoring.

```bash
# Needs GRAFANA_ADMIN_PASSWORD in the env file. The container refuses to start
# without one rather than booting with a default.
docker compose -f docker-compose.app.yml -f docker-compose.observability.yml up -d
```

**Nothing here is published to the internet.** Prometheus scrapes the API over
the internal network — the same reachability the API has to Postgres, which is
why `/metrics` needs no credential. Grafana binds to `127.0.0.1` only, so it is
reached through an SSH tunnel:

```bash
ssh -N -L 3000:127.0.0.1:3000 <user>@<box>
# then open http://localhost:3000
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

## Not done yet

**The restore has never been drilled.** ADR 0009 called off-box database backups non-negotiable; ADR 0037 discharged that by moving the database to Neon, which takes them for us. What is still owed is proving a restore works, and noting that the **free tier's restore window is only six hours** — it must move to Launch before anything irreplaceable is stored. Until that drill has been run, treat both databases as recreatable from scratch.

**Deploys are not zero-downtime.** The API container stops before its replacement starts — a gap of a few seconds.

**Nothing ships logs off the box.** If the disk is lost, so is every log.

**No monitoring or alerting.** A stack that falls over at 3am stays down until somebody looks.
