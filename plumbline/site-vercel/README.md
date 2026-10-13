# Plumbline website on Vercel

`npx vercel --prod --yes` from this folder. No build step.

- `/` and every other path (`/prove`, `/lender`, `/docs`, `/monitor`, `/loan/...`, `/api/lead`) are served by the live
  Railway site (`plumbline-production-56e8.up.railway.app`), whose home page is the Lens design. Vercel proxies them, so the
  lead form and the devnet loan pages keep working.
- `/premium/` (Hallmark), `/premium/lens/` and `/premium/lattice/` are the three static design directions, copied from the
  design thread's `site-premium` folder. `/hallmark` and `/lattice` redirect there.
- `/bounties` and `/sealed-evals` redirect to the sealed-eval competition app (`plumbline/app`, its own Vercel project).
