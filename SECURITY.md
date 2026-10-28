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
  never count, and the browser must address AnimeArr by IP or a LAN name.
- Logins from home work. A banner ("You're still using the default password (morebooty). Change it, Captain.") stays
  until you change the password in Settings → Security; once you do, the rule and the banner are gone.
- Only a salted scrypt hash is stored; "still the default" is a comparison against that hash. The plaintext is never
  saved.
- The default is only created when there is no account. Updating an install that already has an account never resets
  or changes it (including the "No password on my local network" setting).

## Hardening tips

- Change the default password (captain / morebooty) right after the first login.

- Don't expose AnimeArr to the internet without a reverse proxy with authentication or a VPN. If you use a proxy, set
  `TRUST_PROXY` to its IP/CIDR.
- "No password on my local network" is for home networks only; leave it off if the port is forwarded.
- API keys and passwords are stored encrypted in `/config` (with `secret.key`); keep backups of that folder private.
