# Deployment

How a commit becomes a running process, and how to undo it.

Everything here follows [ADR 0009](../../adr/0009-self-hosted-vps-with-off-box-backups.md) (one self-hosted KVM VPS, staging and production sharing it) and [ADR 0012](../../adr/0012-immutable-image-tags-and-compose-deploys.md) (immutable image tags, the box never builds).

> **Not yet exercised against a real box.** Every command below has been rehearsed locally and in CI against the same compose files, but no VPS exists yet. Expect to correct this file the first time it is used for real, and treat that as the point of writing it down.

## What is here

| File                         | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `docker-compose.app.yml`     | One environment: API, worker, Postgres, Redis. Two copies can run.     |
| `docker-compose.ingress.yml` | The shared edge. One per box, holds ports 80/443 and the certificates. |
| `Caddyfile`                  | TLS and hostname routing for both environments.                        |
| `app.env.example`            | Template for `/opt/rental/<env>.env`.                                  |
| `ingress.env.example`        | Template for `/opt/rental/ingress.env`.                                |

The repository root's `docker-compose.yml` is the **local development** stack and is unrelated to any of this.

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

**2. Docker.**

```sh
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

**3. Close everything except SSH and HTTP(S).**

Postgres and Redis publish no ports, so they are already unreachable — this is the second layer, not the first.

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

Then edit each one. For the two app environments, set `APP_ENV` to match the filename and generate a **different** password for each:

```sh
openssl rand -base64 32
```

Leave `IMAGE_TAG` empty. The deploy script fills it in.

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
# A psql shell. Postgres publishes no port, so go in through the container.
docker exec -it rental-production-postgres psql -U rental -d rental

# When did the current release start?
docker inspect rental-production-api --format '{{.State.StartedAt}}'

# Reclaim space. Tagged images are rollback targets — this removes only
# untagged layers.
docker image prune -f
```

## Not done yet

**There are no backups.** ADR 0009 calls off-box database backups non-negotiable and they are not built. Until they are, nothing that cannot be recreated from scratch should go into either database. This is the single largest gap in this directory.

**Deploys are not zero-downtime.** The API container stops before its replacement starts — a gap of a few seconds.

**Nothing ships logs off the box.** If the disk is lost, so is every log.

**No monitoring or alerting.** A stack that falls over at 3am stays down until somebody looks.
