# mirror-server-updates — env URL → www

One-line change to `.github/workflows/ci-cd.yml`: update the GitHub
Actions deployment-environment URL from the bare apex to the canonical
www host. Cosmetic — the link surfaced in the Deployments tab / PR
sidebar no longer goes through the 301 hop.

```diff
- url: https://theundergroundrailroad.world/mirror/api/health
+ url: https://www.theundergroundrailroad.world/mirror/api/health
```

The Health check curl itself (`https://localhost:8444/mirror/api/health`)
is unchanged because it bypasses Apache entirely and was unaffected by
the apex-redirect.

## Deployment

```bash
# In the mirror-server checkout:
cp <admin-checkout>/mirror-server-updates/.github/workflows/ci-cd.yml \
   .github/workflows/ci-cd.yml

git diff .github/workflows/ci-cd.yml    # one-line change
git add .github/workflows/ci-cd.yml
git commit -m "ci: update env URL to canonical www"
git push
```
