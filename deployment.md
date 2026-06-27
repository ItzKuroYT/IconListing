# Icon Listing Deployment

Use Vercel environment variables for production. Vercel KV is not required.

## Required

- `GITHUB_TOKEN`: GitHub token with read/write access to the repo contents.
- `GITHUB_REPO`: Repo in `owner/name` format, for example `ItzKuroYT/icon-listing`.
- `SESSION_SECRET`: Long random secret used to sign login sessions. Do not change this after users are logged in unless you want to force everyone to log in again.
- `ALLOWED_ORIGINS`: Comma-separated public site origins, for example `https://minecraft-listing.iconrealms.net,https://icon-listing.vercel.app`.

## Recommended

- `GITHUB_BRANCH`: Branch to save the JSON database on. Defaults to `main`.
- `GITHUB_DB_PATH`: Main JSON database path. Defaults to `data/icon-listing-db.json`.
- `GITHUB_DB_BACKUP_PATH`: Backup JSON database path. Defaults to the main path with `.backup` before `.json`.
- `DATABASE_ENCRYPTION_KEY`: Optional key for encrypted database storage. Keep the same value forever once enabled.

## Notes

- The public domain should be `https://minecraft-listing.iconrealms.net/`.
- The API stores listings, users, votes, sponsored clients, and sponsored hosts in the GitHub JSON database and keeps a backup JSON file.
- Fresh signup sessions are signed with enough account info to keep users logged in while GitHub storage catches up, but admin actions still require the user to exist in the stored database.
