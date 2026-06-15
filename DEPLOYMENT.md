# Icon Listing Deployment

Icon Listing is a static frontend plus one Vercel API function. The posting method matches the old IconRealms forums site: the Vercel API writes a shared JSON database into GitHub using the GitHub Contents API, and every browser reads the shared state from the Vercel API.

GitHub Pages can host the frontend, but it cannot save listings by itself. Vercel `/tmp` storage is temporary and not shared reliably, so production uses GitHub JSON storage.

## Vercel Project Settings

Set the Vercel project root directory to:

```text
IconListing
```

Use this API URL for the frontend:

```text
https://icon-listing.vercel.app/api
```

The repo already has this in `config.js`:

```js
api: {
  basePath: "/api",
  productionBasePath: "https://icon-listing.vercel.app/api",
  useLocalFallback: true,
  localFallbackHosts: ["", "localhost", "127.0.0.1"],
  requestTimeoutMs: 8000
}
```

## Required Vercel Environment Variables

Add these in Vercel Project Settings -> Environment Variables:

```text
GITHUB_TOKEN=github_pat_or_token_with_repo_contents_read_write_access
GITHUB_REPO=YourGitHubUser/YourRepoName
GITHUB_BRANCH=main
GITHUB_DB_PATH=data/icon-listing-db.json
SESSION_SECRET=put-a-long-random-secret-here
```

`GITHUB_TOKEN` needs Contents read/write access for the repo in `GITHUB_REPO`.

`GITHUB_REPO` must be in `owner/repo` format, for example:

```text
IconRealms/IconListing
```

`GITHUB_BRANCH` should match the branch Vercel deploys from, usually:

```text
main
```

`GITHUB_DB_PATH` is where listings, accounts, votes, sponsored clients, and admin changes are stored. The default is:

```text
data/icon-listing-db.json
```

`SESSION_SECRET` signs login sessions. Use a long random value and do not reuse public examples.

## GitHub Token Setup

Create a fine-grained personal access token in GitHub:

1. GitHub -> Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens.
2. Select the repository used by `GITHUB_REPO`.
3. Give it `Contents: Read and write`.
4. Copy the token into Vercel as `GITHUB_TOKEN`.

## Deploy Order

1. Commit and push the latest Icon Listing files.
2. Add the Vercel environment variables above.
3. Redeploy the Vercel project.
4. Open:

```text
https://icon-listing.vercel.app/api?action=state
```

A working API returns JSON with:

```text
servers
clients
votes
user
```

5. If using GitHub Pages for the frontend too, redeploy GitHub Pages after `config.js` changes.

## Expected Behavior

When a user creates a listing:

1. The browser posts to `https://icon-listing.vercel.app/api?action=saveServer`.
2. The Vercel API validates the listing.
3. The API writes the updated JSON database to `GITHUB_DB_PATH`.
4. Other browsers load `https://icon-listing.vercel.app/api?action=state`.
5. The new listing appears for everyone.

If the API says `Database is not configured`, one of the required GitHub storage variables is missing or the token cannot access the repo.
