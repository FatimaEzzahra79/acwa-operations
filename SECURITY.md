# Security Policy

## Supported versions

Security fixes are applied to the `master` branch only. There is no published
release channel; the repository is maintained as a portfolio snapshot.

| Version | Supported |
| ------- | --------- |
| `master` | ✅ |

## Reporting a vulnerability

If you discover a security issue in this project, **please do not open a public
issue**. Instead, use one of the following channels:

- **GitHub Private Vulnerability Reporting** — *Security* tab → *Report a
  vulnerability* (preferred)
- Contact the author directly by e-mail: **fatimzahra.hibat.allah@gmail.com**

You will receive an acknowledgement within 72 hours and a status update within
7 working days. Please include:

1. A description of the issue and its impact
2. Steps to reproduce, or a proof of concept
3. Affected endpoint(s), file(s) and version/commit

## Scope

In scope:

- Authentication, authorisation and session handling
- Injection flaws (SQL, XSS, command injection)
- Insecure direct object references / broken access control
- Sensitive data exposure, secrets in source or history
- Dependency vulnerabilities with a realistic attack path

Out of scope:

- Denial of service / rate-limit exhaustion
- Social engineering, physical attacks
- Reports against third-party dependencies with no path to this application
- Issues requiring root/admin access to the host machine

## Hardening baseline

This project already implements the controls listed in the
[Security architecture](README.md#-security-architecture) section of the
README — bcrypt password hashing, JWT with short expiry, an authentication gate
on every API route, role-based access control, brute-force rate limiting,
parameterised SQL queries, closed CORS by default, HTTP security headers and a
zero-secrets repository policy.

GitHub **secret scanning** with **push protection**, **Dependabot alerts** and
**branch protection** on `master` are enabled on this repository.
