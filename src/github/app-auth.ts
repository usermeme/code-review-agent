import { App, Octokit } from 'octokit';
import type { AppConfig } from '../config/schema.js';

export function createGithubApp(cfg: AppConfig): App {
  return new App({
    appId: cfg.github.appId,
    privateKey: Buffer.from(cfg.github.privateKeyBase64, 'base64').toString('utf8'),
    webhooks: { secret: cfg.github.webhookSecret },
  });
}

export async function getInstallationOctokit(app: App, installationId: number): Promise<Octokit> {
  return app.getInstallationOctokit(installationId);
}

/** Short-lived token usable as a password for `git clone` over HTTPS. */
export async function createInstallationToken(app: App, installationId: number): Promise<string> {
  const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });
  return data.token;
}

/** Resolves the installation id for a repository (used by the CLI shim). */
export async function getRepoInstallationId(app: App, owner: string, repo: string): Promise<number> {
  const { data } = await app.octokit.rest.apps.getRepoInstallation({
    owner,
    repo,
  });
  return data.id;
}
