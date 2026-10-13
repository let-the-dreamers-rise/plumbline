# Plumbline website on Vercel

`npx vercel --prod --yes` from this folder. No build step.

- `/` is the motion home page (copied from `plumbline/site-motion/`: `index.html`, `css/`, `js/`, `vendor/`). Static files win
  over rewrites on Vercel, so these are served from here.
- Every other path (`/prove`, `/lender`, `/docs`, `/monitor`, `/loan/...`, `/api/lead`) is proxied to the live Railway site
  (`plumbline-production-56e8.up.railway.app`), so the pilot form and the devnet loan pages keep working. `/classic` shows
  Railway's home page (the Lens design).
- `/premium/` (Hallmark), `/premium/lens/` and `/premium/lattice/` are the earlier design directions; `/hallmark` and
  `/lattice` redirect there.
- `/bounties` and `/sealed-evals` redirect to the sealed-eval competition app (`plumbline/app`, its own Vercel project).

After `plumbline/site-motion/` changes, copy it here again before deploying.
