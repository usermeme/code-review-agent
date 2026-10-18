# @code-review-agent/endpoints

Type-safe endpoint definitions and path interpolation utilities.

## Features

- **`EndpointPayloadRecord`**: Type registry mapping endpoints to their payload requirements.
- **`Endpoint`**: Union of known endpoints (`keyof EndpointPayloadRecord`).
- **`ENDPOINTS`**: Constants for all application endpoints.
- **`interpolatePath`**: Type-safe helper replacing path parameters (e.g., `:owner`, `:repo`, `:prNumber`) with URL-encoded values from the payload.

## Usage

```typescript
import { ENDPOINTS, interpolatePath } from '@code-review-agent/endpoints';

const path = interpolatePath(ENDPOINTS.PR_DIFF, {
  Path: {
    owner: 'octocat',
    repo: 'hello-world',
    prNumber: 42,
  },
});
// => '/api/v1/repos/octocat/hello-world/pulls/42/diff'
```
