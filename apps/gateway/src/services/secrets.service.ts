import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

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

    return version.payload.data.toString();
  } catch (error) {
    console.error(`Failed to fetch secret ${secretName}:`, error);
    throw error;
  }
}
