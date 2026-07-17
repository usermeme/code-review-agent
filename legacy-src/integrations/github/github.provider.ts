import type { PlatformProvider } from '../vcs/interfaces/vcs-provider.interface.js';
import type {
  PlatformClient,
  CodeReviewPublisher,
} from '../vcs/interfaces/vcs-client.interface.js';
import type {
  ProviderId,
  RepositoryIdentifier,
} from '../vcs/types/vcs.types.js';
import { GithubClient } from './github.client.js';
import { GithubReviewPublisher } from './review-publisher.service.js';
import { App } from 'octokit';

export class GithubProvider implements PlatformProvider {
  readonly providerId: ProviderId = 'github';

  constructor(private readonly app: App) {}

  async getClient(installationId: string): Promise<PlatformClient> {
    const octokit = await this.app.getInstallationOctokit(
      Number(installationId),
    );
    const { data } =
      await this.app.octokit.rest.apps.createInstallationAccessToken({
        installation_id: Number(installationId),
      });
    return new GithubClient(octokit, data.token);
  }

  async getPublisher(installationId: string): Promise<CodeReviewPublisher> {
    const octokit = await this.app.getInstallationOctokit(
      Number(installationId),
    );
    return new GithubReviewPublisher(octokit);
  }

  parseUrl(
    url: string,
  ): {
    repo: RepositoryIdentifier;
    resourceType: 'issue' | 'pr';
    id: number;
  } | null {
    // Expected format: https://github.com/owner/repo/pull/123 or https://github.com/owner/repo/issues/123
    const match = url.match(
      /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/,
    );
    if (!match) return null;

    return {
      repo: {
        provider: this.providerId,
        owner: match[1]!,
        name: match[2]!,
      },
      resourceType: match[3] === 'pull' ? 'pr' : 'issue',
      id: Number(match[4]),
    };
  }
}
