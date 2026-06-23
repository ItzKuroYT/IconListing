# Icon Listing Deployment

## Required Vercel Variables

Set these in Vercel Project Settings -> Environment Variables for Production.

```text
GITHUB_TOKEN=github_pat_or_token_with_contents_read_write
GITHUB_REPO=owner/private-storage-repo
GITHUB_BRANCH=main
GITHUB_DB_PATH=data/icon-listing-db.json
GITHUB_DB_BACKUP_PATH=data/icon-listing-db.backup.json
SESSION_SECRET=a_long_random_secret
DATABASE_ENCRYPTION_KEY=a_long_random_database_encryption_secret
```

Use a private GitHub repository for `GITHUB_REPO` if possible. If the database is stored in a public repository without `DATABASE_ENCRYPTION_KEY`, account emails and password hashes in the JSON file can be exposed.

## Storage Rules

- Production must use GitHub JSON storage. Do not rely on Vercel temporary files for listings.
- The API writes the main database JSON to `GITHUB_DB_PATH`.
- Before overwriting the main database, the API writes the previous database to `GITHUB_DB_BACKUP_PATH`.
- If `DATABASE_ENCRYPTION_KEY` is set, both JSON files are encrypted at rest with AES-256-GCM.
- Vote and analytics writes now require the existing server to still exist in storage before saving. If storage reads empty or wrong, the write is blocked instead of wiping listings.

## Restore Notes

The local workspace currently has a JSON database at:

```text
data/icon-listing-db.json
```

Use that file to restore the production database if the Vercel API is returning an empty state. Upload it to the configured `GITHUB_DB_PATH` in the storage repo, then redeploy or retry the site.

If production is already using encrypted storage, restore through the API or temporarily run the app locally with the same `DATABASE_ENCRYPTION_KEY` so the restored file is written encrypted.
