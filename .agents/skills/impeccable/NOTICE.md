# NOTICE

This directory vendors the `impeccable` skill. `SKILL.md` declares it
Apache-2.0 and points here for attribution; the full licence text sits
alongside this file in `LICENSE`.

## Attribution

Per the `license:` field in `SKILL.md`, this skill is based on Anthropic's
`frontend-design` skill and is distributed under the Apache License 2.0.
Redistribution must retain that licence, this notice, and any attribution
carried by the files themselves.

## Third-party code

`scripts/modern-screenshot.umd.js` is a pre-built bundle of the
`modern-screenshot` library. It is not an npm dependency of this repo — it
does not appear in `package-lock.json` — and the bundle as committed carries
**no copyright or licence header**:

```bash
grep -icE 'copyright|licen[cs]e' .agents/skills/impeccable/scripts/modern-screenshot.umd.js   # 0
```

Its upstream notice was stripped before vendoring. Restore the upstream
`LICENSE` text for the exact bundled version here before redistributing this
directory — the copyright holder and licence terms must be taken from
upstream, not reconstructed.
