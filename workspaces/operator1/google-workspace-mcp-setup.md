# Google Workspace MCP Server Setup Guide

This guide will help you set up the Google Workspace MCP server (`workspace-mcp`) for Gmail and Google services integration.

## Prerequisites

- A Google account
- Access to Google Cloud Console

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click on the project dropdown at the top and select **"New Project"**
3. Enter a project name (e.g., "OpenClaw Workspace MCP")
4. Click **"Create"**
5. Select your new project from the dropdown

## Step 2: Enable Required APIs

In your Google Cloud Project, enable the following APIs:

1. Go to **APIs & Services** → **Library**
2. Search for and enable each of these APIs:
   - **Gmail API**
   - **Google Calendar API**
   - **Google Drive API**
   - **Google Docs API**
   - **Google Sheets API**

Click **"Enable"** for each one.

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose **"External"** user type (unless you have a Google Workspace account)
3. Click **"Create"**
4. Fill in the required fields:
   - **App name:** OpenClaw Workspace MCP
   - **User support email:** Your email
   - **App logo:** (optional)
   - **Developer contact email:** Your email
5. Click **"Save and Continue"**
6. **Scopes:** Click "Add or Remove Scopes" and add these scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/spreadsheets`
7. Click **"Save and Continue"**
8. **Test users:** Add your own email address
9. Click **"Save and Continue"**
10. Click **"Back to Dashboard"**

## Step 4: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **"Create Credentials"** → **"OAuth client ID"**
3. Select **"Desktop app"** as the application type
4. Enter a name (e.g., "OpenClaw Desktop Client")
5. Click **"Create"**
6. A dialog will appear with your credentials:
   - **Client ID** - Copy this
   - **Client Secret** - Copy this

## Step 5: Update MCP Server Configuration

1. Open `~/.openclaw/mcp/servers.yaml`
2. Find the `google-workspace` section
3. Replace the placeholder values:
   ```yaml
   google-workspace:
     type: stdio
     command: uvx
     args:
       - "workspace-mcp"
       - "--tool-tier"
       - "extended"
     env:
       GOOGLE_OAUTH_CLIENT_ID: "YOUR_CLIENT_ID_HERE"
       GOOGLE_OAUTH_CLIENT_SECRET: "YOUR_CLIENT_SECRET_HERE"
       OAUTHLIB_INSECURE_TRANSPORT: "1"
     enabled: true # Change to true
   ```
4. Save the file

## Step 6: Restart OpenClaw Gateway

After updating the credentials, restart the gateway:

```bash
openclaw gateway restart
```

## Step 7: First-Time Authentication

When you first use a Google Workspace tool, you'll be prompted to authenticate:

1. A browser window will open
2. Sign in with your Google account
3. Grant the requested permissions
4. The authentication token will be saved locally

## Troubleshooting

### "Access blocked" error

- Make sure you've added yourself as a test user in the OAuth consent screen
- Verify the app is in "Testing" mode (not "Production")

### "Invalid client" error

- Double-check the Client ID and Client Secret are copied correctly
- Ensure there are no extra spaces or quotes

### API not enabled errors

- Go back to Step 2 and make sure all required APIs are enabled

## Security Notes

- **Never share** your Client ID and Client Secret
- The `OAUTHLIB_INSECURE_TRANSPORT: "1"` setting is for local development only
- Tokens are stored locally in your home directory
- You can revoke access at any time from your Google Account settings

## Useful Links

- [Google Cloud Console](https://console.cloud.google.com/)
- [workspace-mcp GitHub](https://github.com/aaronsb/workspace-mcp)
- [Google API Documentation](https://developers.google.com/apis-explorer)
