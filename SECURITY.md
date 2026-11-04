# Security

AnimeArr manages downloads and files on your server and stores API keys for your other services, so security reports
are very welcome.

## Reporting

Please **don't open a public issue**. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/MoriTranslates/animearr/security/advisories/new). Include the version, how to
reproduce it, and what an attacker could do. You'll get an answer within a few days; fixes go out as a new image and are
credited (if you want) in the release notes.

## Supported versions

The latest beta. There are no long-term branches yet.

## The default login

A fresh install starts with the login **captain / morebooty**. It works only on your home network until you change it:

- While the password is still the default, a login from an address **outside your home network** is refused with
  "The default password only works from your home network. Log in from home and change it first." Home network means
  the same addresses as "No password on my local network": 10.x, 192.168.x and IPv6 link-local (`fe80::/10`) by
  default, or exactly the ranges in `ANIMEARR_LOCAL_NETWORKS` (comma-separated IPv4 or IPv6 CIDRs). Docker's 172.16/12,
  IPv6 private (ULA, `fc00::/7`, which is also what Docker's IPv6 networks use) and loopback don't count unless you list
  them (a reverse proxy, tunnel or Docker gateway would make everyone look local), requests that came through any proxy
  (one listed in `TRUST_PROXY`, or any request carrying `X-Forwarded-For` or similar headers) never count, a hop-count
  `TRUST_PROXY` turns the no-password check off, and the browser must address AnimeArr by IP or a LAN name (or a name
  in `ANIMEARR_ALLOWED_HOSTS`).
- **With `TRUST_PROXY` set, the default login is off.** The default login exists only for a home browser talking
  directly to AnimeArr. When `TRUST_PROXY` is set to anything (an exact IP, a range, a keyword such as `uniquelocal`,
  or a hop count), every login with the default password is refused, from any address, with "AnimeArr is set to sit
  behind a proxy (TRUST_PROXY), so the default login is off. Set a password first: ...". The reason: a TCP forwarder
  or tunnel (nginx `stream`, HAProxy in tcp mode, frp, `ssh -R`, socat) at an address `TRUST_PROXY` covers passes the
  client's own `X-Forwarded-For` through untouched, so an internet client can claim any home address, and AnimeArr
  can't tell such a forwarder from an HTTP proxy. To set a password: remove `TRUST_PROXY` and restart AnimeArr, open it
  directly (by its IP and port, not through the proxy) from a browser on your home network, log in and change the
  password, then set `TRUST_PROXY` again and restart. `TRUST_PROXY=0`, an empty value and `false` count as unset (Fastify
  trusts no proxy with them either); `TRUST_PROXY=true` is refused with a warning at startup and also counts as unset.
  Logins with your own password work through the proxy as usual. Tailscale addresses
  (`fd7a:115c:a1e0::/48`) are ULA, so they only count if you list them, e.g.
  `ANIMEARR_LOCAL_NETWORKS=10.0.0.0/8,192.168.0.0/16,fd7a:115c:a1e0::/48`; then devices on your tailnet, **including
  nodes shared with you or by you**, count as home network.
- **The limit of this check.** "Home network" is decided by the address the connection comes from (10.x, 192.168.x,
  IPv6 link-local or your listed ranges, with no proxy headers). If internet traffic reaches AnimeArr *from* a LAN
  address, AnimeArr can't tell the difference. That happens with a router port-forward that uses NAT/masquerade, or
  with a plain TCP forwarder such as nginx `stream`, HAProxy in tcp mode, frp, `ssh -R` or socat that `TRUST_PROXY`
  doesn't cover: a forwarder adds no headers, so its traffic looks like a home browser. This affects the default login
  while `TRUST_PROXY` is unset, and "No password on my local network" whenever the forwarder's address isn't in
  `TRUST_PROXY`. So: change the default password on first run, don't port-forward AnimeArr directly, and if you expose
  it, use a normal HTTP reverse proxy (which adds `X-Forwarded-For`) with `TRUST_PROXY` set.
- Logins from home work. A banner ("You're still using the default password (morebooty). Change it, Captain.") stays
  until you change the password in Settings → Security; once you do, the rule and the banner are gone.
- Deliberate (won't fix): a remote login with the default password gets its own "only works from your home network"
  message instead of "wrong password", so an outsider can tell the install still uses the default. That message is how
  you find out why your own remote login fails, and the default password can't be used remotely anyway.
- Deliberate trade-off in the login throttle: your real user name always keeps its own back-off, so junk logins from
  the same address (everyone behind one proxy) can't lock you out. While an address floods made-up names, those get
  "too many attempts" (429) but the real name still answers "wrong password" (401), which can reveal the user name to
  that flooder. The password is still needed, and guessing it is throttled on its own. **The user name is not treated
  as a secret** (a fresh install's is the published `captain`).
- Login floods: password checks run a few at a time, shared fairly between addresses, so a flood from a few addresses
  only delays a new login. A large flood can refuse one: from thousands of addresses (cheap over IPv6) a browser
  AnimeArr hasn't seen before gets "too many login attempts at once" (429), or waits longer than the browser does.
  Logins whose browser has given up are skipped, not checked. A browser you have logged in with before carries a
  signed "known device" cookie (a year, httpOnly, kept after logout, void after a password change). Only a correct
  password (a login or a password change) issues one; being signed in does not, so a stolen session cookie can't mint
  them. It grants nothing by itself, but its logins get their own back-off and their own password-check lane, so
  floods that name your user name, or come from the address you share, can't lock that browser out.
  **Known limit:** a browser that was already signed in before device cookies existed has none until its next password
  login (or password change). Until then, once its session ends, its logins share the lanes of browsers AnimeArr hasn't
  seen, so a large flood can delay or refuse them. Logging out and back in once gives it a device cookie.
- **What bounds password guessing:** each address (IPv6: each /64) gets 5 free tries per user name, then waits 2, 4,
  8 and at most 15 seconds between tries. Guesses at your real user name are also limited across **all** addresses
  together: bursts of 60, then 30 a minute (about 43,000 a day at most), however many addresses an attacker uses. A
  strong password is what makes that number harmless. While such a flood lasts, a browser AnimeArr hasn't seen before
  gets "too many attempts"; a known-device browser and an already signed-in session are not affected. That includes
  the steps that ask a signed-in session for the password again (changing it, restoring a backup, downloading one):
  they are throttled on the browser's device, or on one shared "signed-in" entry, never on the anonymous entry a
  flood from your proxy's address uses up.
- Only a salted scrypt hash is stored; "still the default" is a comparison against that hash. The plaintext is never
  saved.
- The default is only created when there is no account. Updating an install that already has an account never resets
  or changes it (including the "No password on my local network" setting).

## Hardening tips

- Change the default password (captain / morebooty) right after the first login.
- Don't port-forward AnimeArr directly, and don't put it behind a plain TCP forwarder (see "The limit of this check"
  above): to the home-network check, that traffic can look local.
- Don't expose AnimeArr to the internet without an HTTP reverse proxy with authentication, or a VPN. If you use a proxy,
  set `TRUST_PROXY` to its IP/CIDR. Avoid the hop-count form (`TRUST_PROXY=1`): AnimeArr can't check who sent the
  forwarded headers, so it never uses them for the client address. Logs then show only the proxy, everyone behind it
  shares one login back-off, and "No password on my local network" is off. The keywords `loopback`, `linklocal` and
  `uniquelocal` work in the list and stand for their whole ranges (`uniquelocal` is 10/8, 172.16/12, 192.168/16 and
  fc00::/7). Every address in a listed range counts as a proxy, so with `uniquelocal` no home device gets the no-password
  check. List your proxy's own IP instead when you can. `uniquelocal` also includes Docker's 172.16/12, so Fastify takes
  the client address from `X-Forwarded-For` for any request arriving through Docker's gateway or docker-proxy, which a
  client can set itself: log lines and the login back-off can then show a made-up address. Any `TRUST_PROXY` value
  also turns the default login off (see above), so set a password before you set it.
- "No password on my local network" is for home networks only; leave it off if the port is forwarded in any way, and
  think twice before listing your Tailscale range if you share Tailscale nodes (shared nodes then count as home
  network).
- API keys and passwords are stored encrypted in `/config` (with `secret.key`); keep backups of that folder private.
- Known limitation: the calendar (iCal) link's token is derived from the API key. A new API key (Settings → Security)
  is the only way to revoke a calendar link you shared, and it also changes the link for every subscribed calendar and
  breaks apps that use the old key (Overseerr, Jellyseerr, nzb360…), which then need the new key. The calendar token
  itself can only read the calendar.
- Known limitation: requests from other sites (or another app on the same address) are refused using the
  `Sec-Fetch-Site` and `Origin` headers browsers send. Browsers without Fetch Metadata (Safari before 16.4, old
  embedded webviews) send neither for a plain image or link, so with "No password on my local network" on, a page
  could still make such a browser start a GET (for example an indexer search). It can't read the answer, and nothing a
  GET does deletes or changes settings.

## What AnimeArr does

- Passwords are hashed with salted scrypt and checked with timing-safe comparisons; login attempts are rate-limited.
- Every state-changing request must carry AnimeArr's own header (a CSRF check), and cross-site origins are refused.
- Session cookies are HttpOnly and SameSite=Strict.
- A strict Content-Security-Policy; the page can't be framed by other sites.
- External tools (ffprobe, ffmpeg, mkvtoolnix, 7-Zip) are run with argument lists, never through a shell.
- Secrets are masked in the UI and redacted from logs and error messages. A masked secret is only kept for the same
  destination and the same field; when there is nothing saved to keep (a renamed webhook header, a copied channel)
  the save is refused with "enter it again" instead of silently dropping it.
- The container starts as root only to fix `/config` ownership, then drops to your PUID:PGID.
