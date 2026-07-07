# Trello Import Setup

Kanera can import Trello board JSON exports without any Trello configuration, but uploaded Trello attachments require authenticated Trello access. Trello export JSON contains attachment URLs that generally require the exporting user to be signed in, so Kanera cannot reliably download those files from the JSON alone.

## Enable Attachment Copying

Trello currently issues REST API keys from the **Power-Ups Admin Portal**. For Kanera import, the Power-Up is only Trello's app registration container. Users do not install this Power-Up on their boards, and Kanera does not render anything inside Trello.

Official Trello references:

- API key overview: <https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/>
- REST API client/API key note: <https://developer.atlassian.com/cloud/trello/power-ups/rest-api-client/>
- Power-Up admin portal: <https://trello.com/power-ups/admin>

### Create The Trello App/API Key

1. Sign in to Trello/Atlassian with the account that should own Kanera's Trello app registration.
   - Hosted Kanera should use a Kanera-owned operations account.
   - Self-hosted deployments can use an admin's Trello account or a dedicated service/admin account.
2. Open <https://trello.com/power-ups/admin>.
3. Click **New** to create a Power-Up.
4. Fill in the required fields with deployment-level information. Suggested values:
   - **App / Power-Up name:** `Kanera Trello Import`
   - **Workspace:** any workspace the owning Trello account belongs to
   - **Email / Support contact:** the deployment operator's support email
   - **Author:** `Kanera` or the organisation running this deployment
   - **Iframe connector URL / Connector URL:** use the Kanera web origin, for example `https://kanera.example.com`
5. Save/create the Power-Up.
6. Open the new Power-Up and go to its **API Key** tab.
7. Click **Generate a new API Key**.
8. Copy the generated **API Key**. This is the value for `TRELLO_API_KEY`.

You do **not** need to copy a Trello token into Kanera. Kanera asks each importer to authorize Trello during the import wizard and receives a short-lived user token at that point.

If Trello shows an **Allowed origins** field for the API key, add the public Kanera web origin, for example:

```text
https://kanera.example.com
```

For local development, also add:

```text
http://localhost:4200
```

### Configure Kanera

Set the backend environment variable:

   ```bash
   TRELLO_API_KEY=your-trello-api-key
   ```

Then restart the API service.

In Docker Compose deployments, `docker-compose.yml` forwards `TRELLO_API_KEY` to the backend services. Hosted Kanera should use a Kanera-owned Trello app key. Self-hosted deployments can leave it unset; imports will still work, but uploaded Trello files will be preserved as links instead of copied.

### Quick Smoke Test

1. Upload a Trello JSON export that contains uploaded attachments.
2. Go to the import review step.
3. Confirm that **Connect Trello** appears.
4. Click **Connect Trello** and approve read access in Trello.
5. Complete the import.
6. Confirm the result shows imported attachments, and the new Kanera cards have attachment rows rather than only preserved Trello links.

If **Connect Trello** does not appear, check:

- `TRELLO_API_KEY` is set in the API process environment.
- The API service was restarted after setting it.
- The Trello JSON export actually contains uploaded attachments, not only external link attachments.
- The browser can open Trello's authorization popup.

## User Flow

When a Trello JSON export contains uploaded attachments and `TRELLO_API_KEY` is configured, the import wizard shows a **Connect Trello** action on the review step.

- The user authorizes Kanera with Trello `read` scope.
- The Trello token is kept in browser memory and sent only with the import commit request as `X-Trello-Token`.
- Kanera does not persist the Trello token in the import row, mappings, source JSON, or result summary.
- Uploaded Trello attachments are downloaded through Trello with the deployment API key plus the user's short-lived token.
- External link attachments are preserved as links on imported card descriptions.

If the user does not connect Trello, or if the deployment has no `TRELLO_API_KEY`, Kanera preserves Trello attachment links on imported cards and skips file copying.

## Copy Rules

Kanera copies only Trello attachments where the JSON marks `isUpload: true`.

For each copied file, Kanera:

- Validates the file type against Kanera's attachment allowlist.
- Applies the organisation's normal attachment file-size and storage-quota limits.
- Uploads the file into Kanera storage.
- Creates a `card_attachment` row.
- Generates thumbnails and cover derivatives for supported image types.
- Emits normal realtime attachment events after import commit.

Per-file failures do not fail the whole import. Unsupported, inaccessible, oversized, or over-quota files are skipped with warnings in the import result.

## Trello App Notes

The authorization URL is generated by the web import wizard using:

- `scope=read`
- `expiration=1day`
- `response_type=token`
- `callback_method=fragment`

The callback returns to the Kanera web origin at `/trello-auth-callback`; the wizard polls the popup until Trello redirects back with the token fragment, then closes it.

## Security Notes

- `TRELLO_API_KEY` identifies the Kanera Trello app but does not grant access to user data by itself.
- Trello user tokens are treated as transient import credentials.
- Do not log the `X-Trello-Token` header.
- Do not store Trello user tokens in the database.
- Keep attachment-copy warnings file-focused and avoid including signed Trello URLs or tokens.
