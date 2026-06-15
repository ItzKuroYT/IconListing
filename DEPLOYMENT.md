# Icon Listing Deployment

Dynamic listings need the Vercel API and a persistent database. GitHub Pages can host the static files, but it cannot store new accounts, server listings, votes, or admin changes by itself.

## Vercel

1. Set the Vercel project root directory to `IconListing`.
2. Add Vercel KV storage to the project.
3. Redeploy after KV is connected so these environment variables are available:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
4. Open `https://your-vercel-domain.vercel.app/api?action=state`.
   - A working setup returns JSON with `servers`, `clients`, `votes`, and `user`.
   - If KV is missing, the API returns: `Database is not configured. Add Vercel KV to this project so listings are shared publicly.`

## GitHub Pages Static Frontend

If the frontend is served from GitHub Pages, set `api.productionBasePath` in `config.js` to the Vercel API URL:

```js
api: {
  basePath: "/api",
  productionBasePath: "https://your-vercel-domain.vercel.app/api",
  useLocalFallback: true,
  localFallbackHosts: ["", "localhost", "127.0.0.1"],
  requestTimeoutMs: 8000
}
```

Without `productionBasePath`, a GitHub Pages site will request `/api` from GitHub Pages, which has no serverless API. In production, the app now shows an error instead of saving listings privately in one browser.
