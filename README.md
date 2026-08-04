# template-typescript

A TypeScript service template: Express, SQLite, Vitest, and a `Makefile` that
covers everything from `make setup` to `make deploy`.

Run `make` to see every target.

```sh
make setup   # install nvm, Node, and dependencies
make run     # run in dev mode
make test    # run tests
make check   # lint and typecheck
```

## Deployment

The deployment story is ported from
[exokomodo/spigot](https://github.com/exokomodo/spigot). One Linux box runs two
things: systemd supervises the Node process on `127.0.0.1:3000`, and nginx
serves port 80/443 and proxies to it. Nothing else — no containers, no process
manager.

**This ships disabled.** `.github/workflows/cd.yml` is gated on the `CD_ENABLED`
repository variable, so a fresh copy of the template never deploys anywhere. See
[Enabling CD](#enabling-cd) below.

### Change these first

Every deployment value in the template is a placeholder. `example.com` is not
your server — deploying without replacing it will fail against a domain you do
not own.

- `SERVICE_NAME` — names the unit, nginx site, and log files. Ships as `app`;
  set it in the `Makefile`.
- `SERVER_NAME` — the hostname nginx answers for and certbot issues a
  certificate for. Ships as `_` in the `Makefile`, `example.com` in CD; set the
  `SERVER_NAME` repository variable.
- `SSH_HOST` — the host CD connects to. Ships as `example.com`; set the
  `SSH_HOST` repository variable.
- `SSH_USER` — the deploy user. Ships as `deploy`; set the `SSH_USER`
  repository variable.
- `DEPLOY_DIR` — the checkout on the server. Ships as `/srv/app`; set the
  `DEPLOY_DIR` repository variable.
- `APP_PORT` — the port the app listens on. Ships as `3000`; set the `APP_PORT`
  repository variable.

Renaming the service takes one `Makefile` edit: nothing under `etc/` needs
renaming, because every template there substitutes `@SERVICE_NAME@` at install
time.

### Server prerequisites

- Debian/Ubuntu with systemd
- `nginx`
- `certbot` (for TLS)
- `git`, `make`, and a C toolchain (`build-essential`, `python3`) for the
  `sqlite3` native binding
- `nvm`, or the Node version from [.nvmrc](.nvmrc) installed system-wide. A
  non-interactive SSH shell never sources `nvm.sh`, so the `Makefile` looks
  under `$NVM_DIR/versions/node` when `node` is off `PATH` and pins the
  absolute path it finds into the systemd unit.
- A deploy user with `NOPASSWD` sudo, so CD can write `/etc` and restart units

Nothing else needs setting up by hand — the deploy clones the repo and installs
the Node version itself. To see what a host is still missing before deploying to
it, run `make deploy/doctor`; every failing check prints its own fix.

### Configuration files

All live in [etc/](etc/) and are templates — `@PLACEHOLDER@` tokens are
substituted from the `Makefile` variables at install time, so the port and
server name have exactly one source of truth.

- [etc/nginx/app.conf](etc/nginx/app.conf) →
  `/etc/nginx/sites-available/$SERVICE_NAME.conf`, symlinked into
  `sites-enabled/` (the stock `default` site is removed, since it also claims
  port 80). Installed when no certificate exists yet: port 80 only, proxying
  directly.
- [etc/nginx/app-tls.conf](etc/nginx/app-tls.conf) → the same destination,
  installed instead once `/etc/letsencrypt/live/$SERVER_NAME/` holds a
  certificate: port 80 redirects, port 443 proxies.
- [etc/nginx/snippets/app-proxy.conf](etc/nginx/snippets/app-proxy.conf) →
  `/etc/nginx/snippets/$SERVICE_NAME-proxy.conf`, the `proxy_pass` body both of
  the above include, so the proxy is defined once.
- [etc/systemd/app.service](etc/systemd/app.service) →
  `/etc/systemd/system/$SERVICE_NAME.service`
- [etc/systemd/app.env.example](etc/systemd/app.env.example) →
  `/etc/$SERVICE_NAME/$SERVICE_NAME.env`, only if that file does not exist yet

If `nginx -t` rejects a freshly installed config, the previous files are restored
and nginx is never reloaded, so a bad deploy cannot take the site down.

`/etc/$SERVICE_NAME/$SERVICE_NAME.env` is for host-specific overrides and
secrets. Deploys never overwrite it.

### Deploying

```sh
make deploy
```

Run on the server, in order:

1. **Sync** — clones the repo if `$(DEPLOY_DIR)` has no checkout, otherwise
   fetches and hard-resets it to `origin/main`.
2. **Node** — sources `nvm.sh` and runs `nvm install && nvm use`, so the version
   in [.nvmrc](.nvmrc) is present before anything needs it.
3. **Re-exec** — `make` re-invokes itself in the deploy directory, so the rest of
   the run uses the Makefile that was just pulled and re-resolves the Node path
   that step 2 may have just created.
4. **Check** — `deploy/doctor`, now against the synced tree and installed Node.
5. **Release** — `npm ci && npm run build`, install both config files, reload
   nginx, restart the service, then confirm the unit is actually active, dumping
   the last 50 journal lines and failing if it is not.

Useful overrides:

```sh
make deploy SERVER_NAME=app.your-domain.com APP_PORT=3000
make deploy/release   # rebuild and reinstall without pulling
make deploy/status    # unit status plus recent logs
make deploy/logs      # journalctl -f
```

### Enabling CD

[cd.yml](.github/workflows/cd.yml) is the same flow on every push to `main`: it
loads the deploy key, then SSHes in and runs `make deploy`. All of the deploy
logic lives in the `Makefile`, so it behaves identically by hand.

The job carries `if: vars.CD_ENABLED == 'true'`, so until you opt in, every run
shows up in the Actions tab as skipped. To enable it:

1. Fill in the repository secrets: `SSH_PRIVATE_KEY` (a deploy key the server
   accepts) and `SSH_KNOWN_HOSTS` (the output of `ssh-keyscan -H <host>`). Without
   `SSH_KNOWN_HOSTS` the workflow warns and trusts whatever key the host presents.
2. Fill in the repository variables from the table above: `SSH_USER`, `SSH_HOST`,
   `SERVER_NAME`, `DEPLOY_DIR`, `APP_PORT`.
3. Set the `CD_ENABLED` repository variable to `true`.

To disable it again, unset `CD_ENABLED` — or disable the whole workflow from the
Actions tab, which also stops the skipped runs from appearing.

### TLS

This repo owns the nginx config; certbot owns only the certificate. That split is
deliberate: `certbot --nginx` rewrites the installed site file, which the next
deploy would overwrite and break TLS. So certbot runs in `certonly --webroot`
mode instead, answering challenges from `/var/www/certbot` — which both site
configs serve — and never touching nginx config at all.

Once DNS points at the box:

```sh
make deploy/tls SERVER_NAME=app.your-domain.com CERTBOT_EMAIL=you@your-domain.com
```

That installs the HTTP config, issues the certificate, then reinstalls as HTTPS.
Every later `make deploy` sees the certificate and keeps serving the TLS config,
so the switch survives deploys with nothing further to do.

Renewal is certbot's own systemd timer. The `--deploy-hook` registered at
issuance reloads nginx after each renewal.

**Migrating a certificate first issued with `certbot --nginx`:** the certificate
itself is fine and gets picked up on the next deploy, but its renewal config
still names the nginx authenticator and installer, so renewals would keep editing
nginx. Certbot only rewrites that config when it actually issues, so force one
reissue:

```sh
make deploy/tls SERVER_NAME=app.your-domain.com \
  CERTBOT_EMAIL=you@your-domain.com CERTBOT_FORCE=1
```

Confirm with `sudo certbot certificates` and check that
`/etc/letsencrypt/renewal/app.your-domain.com.conf` now reads
`authenticator = webroot` with no `installer = nginx`.
