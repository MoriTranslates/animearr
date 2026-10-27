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

## Hardening tips

- Don't expose AnimeArr to the internet without a reverse proxy with authentication or a VPN. If you use a proxy, set
  `TRUST_PROXY` to its IP/CIDR.
- "No password on my local network" is for home networks only; leave it off if the port is forwarded.
- API keys and passwords are stored encrypted in `/config` (with `secret.key`); keep backups of that folder private.
