# @code-review-agent/endpoints

Type-safe endpoint definitions and path interpolation utilities.

## Features

- **`EndpointPayload`**: Base structure defining `{ Params, Path, Query, Body }` shapes.
- **`EndpointPayloadRecord`**: Type registry mapping endpoints to their payload requirements. Consumers can augment this interface using TypeScript module augmentation.
- **`Endpoint`**: Union of known endpoints (`keyof EndpointPayloadRecord`).
- **`ENDPOINTS`**: Constants for all application endpoints.
- **`interpolatePath`**: Type-safe helper replacing path parameters (e.g., `:owner`, `:repo`) with URL-encoded values from the payload.

## Usage

```typescript
import { ENDPOINTS, interpolatePath } from '@code-review-agent/endpoints';

const path = interpolatePath(ENDPOINTS.REPO_ROOT, {
  Path: {
    owner: 'octocat',
    repo: 'hello-world',
  },
});
// => '/api/v1/repos/octocat/hello-world/'
```
