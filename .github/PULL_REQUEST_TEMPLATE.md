## Summary

<!-- What changed, and which agent integration or shared contract does it affect? -->

## Verification

- [ ] `plugins/remarc/mcp`: `npm ci && npm test && npm run build`
- [ ] `plugins/remarc-hooks/cli`: `npm ci && npm test && npm run build`
- [ ] Committed `dist/` files match the build output
- [ ] Shared schema fixture checked when data contracts changed
- [ ] Marketplace/manifests validated when relevant
- [ ] Live checks identify the exact agent and plugin versions used

## Contract and release impact

- [ ] Unknown `comments.json` fields remain preserved on every read-modify-write path
- [ ] Marker compatibility and preservation are covered when marker fields changed
- [ ] Coordinated Remarc app change is linked when a shared contract changed
- [ ] `CHANGELOG.md` updated for user-visible behavior
- [ ] No credentials, private comments, screenshots, transcripts, or unsanitized local data are included
