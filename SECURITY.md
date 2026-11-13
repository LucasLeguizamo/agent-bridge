# Security policy

agent-bridge connects agents that hold access to real accounts, so we treat these as vulnerabilities:

- An instruction from one agent's input becoming an action by another (prompt injection across the bridge).
- A `side_effect` task delivered without approval, or a way around the loop and quota guards.
- Spoofed email or webhooks being accepted.
- Secrets or tokens leaking into tasks, memory, logs or responses.
- Bridge tables reachable through the Supabase Data API.

## Reporting

Report privately through [GitHub Security Advisories](https://github.com/LucasLeguizamo/agent-bridge/security/advisories/new). Do not open a public issue.

Include the version or commit, the steps to reproduce, and the impact. You will get an answer within 7 days. Once a fix ships, you are credited in the advisory unless you prefer otherwise.

## Supported versions

Only the latest release on `main` gets fixes.
