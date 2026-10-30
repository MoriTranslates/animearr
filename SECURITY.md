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
  the same addresses as "No password on my local network": 10.x, 192.168.x and IPv6 private/link-local addresses by
  default, or exactly the ranges in `ANIMEARR_LOCAL_NETWORKS`. Docker's 172.16/12 and loopback don't count unless you
  list them (a reverse proxy or tunnel would make everyone look local), requests that came through an untrusted proxy
  never count, and the browser must address AnimeArr by IP or a LAN name. Tailscale addresses (IPv6
  `fd7a:115c:a1e0::/48`) are private IPv6 addresses, so devices on your tailnet, **including nodes shared with you or
  by you**, count as home network too.
- **The limit of this check.** "Home network" is decided by the address the connection comes from (10.x, 192.168.x,
  private IPv6, with no proxy headers). If internet traffic reaches AnimeArr *from* a LAN address, AnimeArr can't tell
  the difference. That happens with a router port-forward that uses NAT/masquerade, or with a plain TCP forwarder
  such as nginx `stream`, HAProxy in tcp mode, frp, `ssh -R` or socat. So: change the default password on first run,
  don't port-forward AnimeArr directly, and if you expose it, use a normal HTTP reverse proxy (which adds
  `X-Forwarded-For`) with `TRUST_PROXY` set.
- Logins from home work. A banner ("You're still using the default password (morebooty). Change it, Captain.") stays
  until you change the password in Settings → Security; once you do, the rule and the banner are gone.
- Only a salted scrypt hash is stored; "still the default" is a comparison against that hash. The plaintext is never
  saved.
- The default is only created when there is no account. Updating an install that already has an account never resets
  or changes it (including the "No password on my local network" setting).

## Hardening tips

- Change the default password (captain / morebooty) right after the first login.
- Don't port-forward AnimeArr directly, and don't put it behind a plain TCP forwarder (see "The limit of this check"
  above): to the home-network check, that traffic can look local.
- Don't expose AnimeArr to the internet without an HTTP reverse proxy with authentication, or a VPN. If you use a proxy,
  set `TRUST_PROXY` to its IP/CIDR.
- "No password on my local network" is for home networks only; leave it off if the port is forwarded in any way, and
  think twice if you share Tailscale nodes (shared nodes count as home network).
- API keys and passwords are stored encrypted in `/config` (with `secret.key`); keep backups of that folder private.

## What AnimeArr does

- Passwords are hashed with salted scrypt and checked with timing-safe comparisons; login attempts are rate-limited.
- Every state-changing request must carry AnimeArr's own header (a CSRF check), and cross-site origins are refused.
- Session cookies are HttpOnly and SameSite=Strict.
- A strict Content-Security-Policy; the page can't be framed by other sites.
- External tools (ffprobe, ffmpeg, mkvtoolnix, 7-Zip) are run with argument lists, never through a shell.
- Secrets are masked in the UI and redacted from logs and error messages.
- The container starts as root only to fix `/config` ownership, then drops to your PUID:PGID.
