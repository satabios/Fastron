# Windows Code Signing Setup Guide

This guide explains how to set up Windows code signing for Fastron using Azure Code Signing.

## Overview

The application now uses **Azure Code Signing** (formerly Azure Trusted Signing) to sign Windows executables. This provides:

- ✅ Trusted digital signatures for Windows applications
- ✅ No SmartScreen warnings for users
- ✅ Verified publisher identity
- ✅ Secure cloud-based signing (no need to store certificates locally)

## Prerequisites

### 1. Azure Code Signing Account

You need an Azure Code Signing account. If you don't have one:

1. Go to [Azure Portal](https://portal.azure.com)
2. Create a new **Azure Code Signing** resource
3. Create a certificate profile in the Code Signing account
4. Note down:
   - Code Signing Endpoint URL (e.g., `https://eus.codesigning.azure.net/`)
   - Code Signing Account Name (e.g., `satabios`)
   - Certificate Profile Name (e.g., `satabios`)

### 2. Azure Service Principal

Create a service principal with permissions to use the Code Signing account:

```bash
# Login to Azure
az login

# Create service principal
az ad sp create-for-rbac --name "fastron-code-signing" --role "Code Signing Certificate Profile Signer" --scopes /subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.CodeSigning/codeSigningAccounts/{account-name}

# Note down the output:
# - appId (Client ID)
# - password (Client Secret)
# - tenant (Tenant ID)
```

Alternatively, create it via Azure Portal:
1. Go to **Azure Active Directory** → **App registrations**
2. Create a new registration
3. Create a client secret
4. Assign it the **Code Signing Certificate Profile Signer** role on your Code Signing account

## GitHub Secrets Configuration

Add the following secrets to your GitHub repository:

Go to: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets:

| Secret Name | Description | Example Value |
|------------|-------------|---------------|
| `AZURE_TENANT_ID` | Azure tenant ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_CLIENT_ID` | Service principal client ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_CLIENT_SECRET` | Service principal client secret | `your-secret-value` |

The endpoint, account name, and certificate profile are already configured in the workflow file.

## How It Works

### 1. Build Configuration

The [publish/electron-builder.json](../publish/electron-builder.json) file contains:

```json
"win": {
    "target": [ "nsis" ],
    "sign": "./build/sign.js",
    "signingHashAlgorithms": ["sha256"],
    "publisherName": "satabios",
    "certificateSubjectName": "satabios",
    "azureSignOptions": {
        "endpoint": "https://eus.codesigning.azure.net/",
        "codeSigningAccountName": "satabios",
        "certificateProfileName": "satabios"
    }
}
```

### 2. Custom Signing Script

The [build/sign.js](../build/sign.js) script:
- Checks for required environment variables
- Installs AzureSignTool if needed
- Signs the Windows executable using Azure Code Signing
- Verifies the signature

### 3. GitHub Actions Workflow

The [.github/workflows/publish.yml](../.github/workflows/publish.yml) workflow:
- Runs on Windows, macOS, and Linux
- Passes Azure credentials as environment variables to the build process
- Executes the custom signing script during the Windows build

## Testing the Setup

### Local Testing (Optional)

To test signing locally on Windows:

1. Install .NET SDK (if not already installed)
2. Set environment variables:
   ```cmd
   set AZURE_TENANT_ID=your-tenant-id
   set AZURE_CLIENT_ID=your-client-id
   set AZURE_CLIENT_SECRET=your-secret
   set AZURE_CODE_SIGNING_ENDPOINT=https://eus.codesigning.azure.net/
   set AZURE_CODE_SIGNING_ACCOUNT=satabios
   set AZURE_CERTIFICATE_PROFILE=satabios
   ```
3. Run: `npm run build`

### CI/CD Testing

1. Commit and push your changes
2. Create a tag: `git tag v8.8.2 && git push origin v8.8.2`
3. The GitHub Action will automatically build and sign the Windows installer
4. Check the build logs for signing confirmation

## Verifying Signed Executables

After building:

### On Windows:
```cmd
# Check signature
signtool verify /pa "path\to\Fastron Setup.exe"

# View signature details
signtool verify /pa /v "path\to\Fastron Setup.exe"
```

### Via File Properties:
1. Right-click the .exe file
2. Select **Properties**
3. Go to **Digital Signatures** tab
4. You should see a valid signature with your publisher name

## Troubleshooting

### "AzureSignTool not found"
- Ensure .NET SDK is installed on the build machine
- The script auto-installs AzureSignTool, but you may need to add `~/.dotnet/tools` to PATH

### "Authentication failed"
- Verify your service principal credentials are correct
- Check that the service principal has the correct role assignment
- Ensure the certificate profile exists and is active

### "Missing environment variables"
- Check that all required secrets are set in GitHub Actions
- Verify secret names match exactly (case-sensitive)

### Signature verification fails in CI
- This may be normal in CI environments without full Windows certificate stores
- The signature will still be valid when users download the installer

## Cost Considerations

Azure Code Signing pricing:
- Charged per signing operation
- Check [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) for current rates
- Consider using a budget alert in Azure

## Security Best Practices

1. ✅ **Never commit credentials** - Always use GitHub Secrets
2. ✅ **Rotate secrets regularly** - Update service principal secrets periodically
3. ✅ **Limit permissions** - Service principal should only have Code Signing role
4. ✅ **Monitor usage** - Set up Azure alerts for unusual signing activity
5. ✅ **Audit logs** - Review Azure Code Signing logs regularly

## Alternative: Traditional Certificate Signing

If you prefer using a traditional PFX certificate instead of Azure Code Signing:

1. Obtain a code signing certificate from a Certificate Authority (DigiCert, Sectigo, etc.)
2. Convert to PFX format
3. Add to GitHub Secrets:
   - `WINDOWS_CERTIFICATE_BASE64`: Base64-encoded PFX file
   - `WINDOWS_CERTIFICATE_PASSWORD`: Certificate password
4. Update the signing configuration in electron-builder.json

## Support

For issues related to:
- **Azure Code Signing**: [Azure Code Signing Documentation](https://learn.microsoft.com/azure/code-signing/)
- **electron-builder**: [electron-builder Code Signing Docs](https://www.electron.build/code-signing)
- **AzureSignTool**: [AzureSignTool GitHub](https://github.com/vcsjones/AzureSignTool)

## Next Steps

1. ✅ Set up Azure Code Signing account (if not done)
2. ✅ Create service principal
3. ✅ Add secrets to GitHub
4. ✅ Test the build pipeline
5. ✅ Verify signed executables
6. ✅ Distribute to users!

---

**Note**: The first few installations after signing may still show SmartScreen warnings until Microsoft builds reputation for your certificate. This is normal and will improve over time as more users install the application.
