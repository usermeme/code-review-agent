import type { ProviderId, RepositoryIdentifier } from '../types/vcs.types.js';
import type {
  PlatformClient,
  CodeReviewPublisher,
} from './vcs-client.interface.js';

/**
 * Factory and utility interface representing a specific Git Provider.
 */
export interface PlatformProvider {
  readonly providerId: ProviderId;

  // Instantiates an authenticated client for an installation
  getClient(installationId: string): Promise<PlatformClient>;

  // Instantiates a publisher for an installation
  getPublisher(installationId: string): Promise<CodeReviewPublisher>;

  // Replaces custom URL parsing logic
  parseUrl(
    url: string,
  ): {
    repo: RepositoryIdentifier;
    resourceType: 'issue' | 'pr';
    id: number;
  } | null;
}
