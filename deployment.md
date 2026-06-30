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
- `TURNSTILE_SECRET_KEY`: Cloudflare Turnstile secret key for login and signup protection.
- `GOOGLE_CLIENT_ID`: Google OAuth client ID.
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret.
- `RESEND_API_KEY`: Resend API key used for normal email/password account verification.
- `RESEND_FROM_EMAIL`: Sender identity for verification emails, for example `Icon Listing <verify@noreply.iconrealms.net>`.
- `RESEND_REPLY_TO`: Optional support/reply address for verification emails.
- `DATABASE_ENCRYPTION_KEY`: Optional old/read key for existing encrypted database files. New writes are plaintext unless `ICON_LISTING_ENCRYPT_DB=true` is also set.
- `ICON_LISTING_ENCRYPT_DB`: Optional. Set to `true` only if you want new GitHub JSON database writes encrypted.

## Email Verification

Normal email/password signups receive a 6-digit code through Resend. The signup page does not create a logged-in session until that code is verified.

Set these Vercel variables:

```text
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=Icon Listing <verify@noreply.iconrealms.net>
RESEND_REPLY_TO=your_support_email@example.com
```

Google sign-ins are treated as verified through Google OAuth, so they do not need the 6-digit code.

## Google OAuth

In Google Cloud Console, add these Authorized JavaScript origins:

```text
https://minecraft-listing.iconrealms.net
https://icon-listing.vercel.app
```

Add these Authorized redirect URIs:

```text
https://icon-listing.vercel.app/api/google-callback
https://minecraft-listing.iconrealms.net/api/google-callback
```

The old `/api?action=googleCallback` route still works in code, but the clean `/api/google-callback` URI is the one to use in Google.

## Optional Votifier Relay

- `VOTIFIER_PROVIDER_ENDPOINT`: Optional relay endpoint. Leave this empty for normal direct Votifier/NuVotifier TCP delivery from Vercel.
- `VOTIFIER_PROVIDER_TOKEN`: Optional bearer token for the relay endpoint.

By default the API connects directly to the Minecraft server's Votifier listener host and port. The dashboard supports:

- `Auto detect`: Reads the listener handshake and sends NuVotifier v2 or legacy Votifier automatically.
- `NuVotifier`: Sends the v2 HMAC JSON payload using the configured token.
- `Votifier`: Sends the legacy RSA/PKCS1 encrypted `VOTE` payload using the configured public key.

For direct delivery to work, the Minecraft server host must expose its Votifier port publicly. Minehut or other hosts that do not allow inbound Votifier ports should use the IconListing vote plugin instead.

## Notes

- The public domain should be `https://minecraft-listing.iconrealms.net/`.
- The API stores listings, users, votes, sponsored clients, and sponsored hosts in the GitHub JSON database and keeps a backup JSON file.
- Production writes require GitHub storage. If `GITHUB_TOKEN` or `GITHUB_REPO` is missing on the deployed Vercel project, create/delete/vote requests fail instead of pretending to save in temporary storage.
- Check `https://icon-listing.vercel.app/api?action=health` after deploy. It must show `"durable":true` and `"storage":"github"` before public writes are real.
- Fresh signup sessions are signed with enough account info to keep users logged in while GitHub storage catches up, but admin actions still require the user to exist in the stored database.
