# Security Policy

## Supported Versions

Security updates are provided for the current `main` branch and the latest tagged release, when releases are published.

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Email security reports to Happen Software Limited at `supportt@kanera.app`. Include:

- a clear description of the issue;
- reproduction steps or proof of concept details;
- the affected component or deployment mode;
- any logs, screenshots, or requests that help confirm impact.

We aim to acknowledge reports within 5 business days. We may ask for more detail while we validate impact and prepare a fix.

## Scope

In scope:

- authentication, authorization, tenancy, and private-board access issues;
- stored secret handling and token leakage;
- public API, webhook, upload, realtime, and MCP security issues;
- vulnerabilities in the default self-hosted deployment configuration.

Out of scope:

- attacks that require access to a user's local development machine;
- issues caused only by intentionally weakened local `.env` development values;
- social engineering, spam, or denial-of-service testing against production services without written permission.

## Public Disclosure

Please give maintainers a reasonable opportunity to investigate and release a fix before public disclosure.
