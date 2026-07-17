import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

// Instantiate the client. This automatically picks up Application Default Credentials
// from the mounted ~/.config/gcloud directory in development, or the Service Account in production.
const client = new SecretManagerServiceClient();

/**
 * Fetch a secret securely from Google Cloud Secret Manager at runtime.
 * @param secretName The full resource name (e.g. 'projects/YOUR_PROJECT_ID/secrets/GITHUB_WEBHOOK_SECRET/versions/latest')
 */
export async function getSecret(secretName: string): Promise<string> {
  try {
    const [version] = await client.accessSecretVersion({
      name: secretName,
    });
    
    if (!version.payload || !version.payload.data) {
      throw new Error(`Secret payload is empty for ${secretName}`);
    }

    // The data is a Uint8Array or string. Convert to string.
    return version.payload.data.toString();
  } catch (error) {
    console.error(`Failed to fetch secret ${secretName}:`, error);
    throw error;
  }
}
