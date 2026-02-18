# Charge App

A React + TypeScript rewrite of the nurse room-assignment workflow described in `agents.md`. The UI mirrors the original Shiny prototype while adding persistence, drag-and-drop tweaks, historical discharge tracking, and deterministic allocation powered by the pure engine in `src/utils/assignment.ts`.

## Local development

1. Install dependencies once: `npm install`
2. Start the dev server: `npm run dev`
3. Run unit tests (engine + UI): `npm test`
4. Create a production build locally: `npm run build`

## Deployment (GitHub Pages)

This repository now includes `.github/workflows/deploy.yml`, which builds the site with Vite and publishes the `dist/` output to GitHub Pages whenever `main` receives a push. To publish:

1. Push this repository to GitHub and open *Settings → Pages*.
2. Set the source to **GitHub Actions** (the workflow handles the rest).
3. Ensure the default branch is `main`. Manual runs are possible through the *Actions → Deploy site to GitHub Pages* workflow using the **Run workflow** button.

### Base path handling

- Local development continues to use the default `/` base path.
- The workflow exports `VITE_BASE_PATH=/<repository-name>/` before running `npm run build`, which matches the default project-site URL pattern `https://<user>.github.io/<repository-name>/`.
- If you host the app at `https://<user>.github.io/` (user/organization site) or behind a custom domain, override the environment variable from the workflow dispatch form or by editing the workflow to set `VITE_BASE_PATH=/` (or another path that matches your final URL).

Once the workflow finishes, the deployment URL appears in the *Environments → github-pages* tab and on the run summary page.
