import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { PubSub } from '@google-cloud/pubsub';
import { STATE } from '../constants/state-keys.constant.js';
import type { ReviewResultPayload } from 'shared-types';

export const findingItemSchema = z.object({
  title: z.string().describe('Short headline of the finding'),
  severity: z.enum(['critical', 'major', 'minor']).describe('Severity of the issue'),
  path: z.string().describe('File path of the code issue'),
  startLine: z.number().describe('Starting line number of the finding'),
  endLine: z.number().describe('Ending line number of the finding'),
  body: z.string().describe('Explanation of the bug, risk, or quality defect'),
  suggestion: z.string().optional().describe('Concrete code suggestion replacement, if any'),
});

export function createPublishReviewResultsTool(gatewayUrl: string) {
  const pubsub = new PubSub();
  const topicName = process.env.REVIEW_RESULT_TOPIC || 'review-result-topic';

  return new FunctionTool({
    name: 'publishReviewResults',
    description:
      'Publishes the final review findings and comments to the Gateway so they can be posted inline to GitHub.',
    parameters: z.object({
      provider: z.string().optional().describe('Git provider (e.g. github)'),
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      prNumber: z.number().optional().describe('Pull request number'),
      summary: z.string().describe('Overall summary verdict of the code review'),
      ticketCoverage: z.string().optional().describe('Analysis of linked ticket implementation'),
      findings: z.array(findingItemSchema).describe('List of approved review findings to post inline'),
    }),
    execute: async (input, ctx) => {
      const meta = ctx.state.get<Record<string, any>>(STATE.prMeta);

      const provider = input.provider || meta?.provider || 'github';
      const owner = input.owner || meta?.owner || '';
      const repo = input.repo || meta?.repo || '';
      const prNumber = input.prNumber || meta?.number || 0;

      if (!owner || !repo || !prNumber) {
        throw new Error('Repository owner, name, and PR number are required to publish review results.');
      }

      const comments = input.findings.map((f) => {
        let commentBody = `### [${f.severity.toUpperCase()}] ${f.title}\n\n${f.body}`;
        if (f.suggestion) {
          commentBody += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
        }
        return {
          path: f.path,
          position: f.endLine || f.startLine || 1,
          body: commentBody,
        };
      });

      const payload: ReviewResultPayload = {
        provider,
        owner,
        repo,
        prNumber,
        comments,
      };

      try {
        // 1. Publish to Google Cloud Pub/Sub topic
        await pubsub.topic(topicName).publishMessage({
          json: payload,
        });
        return `Successfully published ${comments.length} review comments to Pub/Sub topic "${topicName}".`;
      } catch (pubsubError) {
        console.warn('Pub/Sub publish failed, attempting direct HTTP POST to gateway...', pubsubError);

        // 2. Direct HTTP fallback to Gateway review results endpoint
        const token = process.env.PUBSUB_SECRET_TOKEN;
        const endpoint = `${gatewayUrl}/api/v1/review/results${token ? `?token=${encodeURIComponent(token)}` : ''}`;

        const httpResponse = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              data: Buffer.from(JSON.stringify(payload)).toString('base64'),
              messageId: `msg-${Date.now()}`,
            },
            subscription: 'agent-direct-push',
          }),
        });

        if (!httpResponse.ok) {
          throw new Error(
            `Direct gateway push returned HTTP ${httpResponse.status}: ${httpResponse.statusText}`,
            { cause: pubsubError },
          );
        }

        return `Successfully sent ${comments.length} review comments directly to gateway.`;
      }
    },
  });
}
