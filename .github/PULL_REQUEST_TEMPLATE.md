## Summary

<!-- What changed, and which agent integration or shared contract does it affect? -->

## Verification

- [ ] `plugins/remarc/mcp`: `npm ci && npm test && npm run build`
- [ ] `plugins/remarc-hooks/cli`: `npm ci && npm test && npm run build`
- [ ] `plugins/remarc-wake`: `npm ci && npm run typecheck && npm test && npm run build`
- [ ] `node scripts/check-public-versions.mjs`
- [ ] `node scripts/check-third-party-notices.mjs`
- [ ] Committed `dist/` files match the build output
- [ ] Shared schema fixture checked when data contracts changed
- [ ] Marketplace/manifests validated when relevant
- [ ] Isolated OMP smoke run for OMP package, manifest, or lifecycle changes
- [ ] Live checks identify the exact agent and plugin versions used

## Contract and release impact

- [ ] Unknown `comments.json` fields remain preserved on every read-modify-write path
- [ ] Marker compatibility and preservation are covered when marker fields changed
- [ ] Coordinated Remarc app change is linked when a shared contract changed
- [ ] `CHANGELOG.md` updated for user-visible behavior
- [ ] No credentials, private comments, screenshots, transcripts, or unsanitized local data are included
