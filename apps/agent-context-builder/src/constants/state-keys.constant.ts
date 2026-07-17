export const STATE = {
  payload: 'payload', // { repo, ref, cloneUrl, token }
  repoDir: 'repoDir', // cloned directory
  headSha: 'headSha',
  chunks: 'chunks',
  overflowPaths: 'overflowPaths',
  agentDocs: 'agentDocs',
  chunkSummaries: 'chunkSummaries',
} as const;
