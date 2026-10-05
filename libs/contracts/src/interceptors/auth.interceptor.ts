import { Interceptor, ConnectError, Code } from '@connectrpc/connect';

export interface AuthInterceptorOptions {
  token: string;
}

export function createAuthInterceptor(
  options: AuthInterceptorOptions,
): Interceptor {
  return (next) => async (req) => {
    const expectedToken = options.token;
    if (!expectedToken) {
      throw new ConnectError(
        'Server misconfiguration: INTERNAL_AUTH_TOKEN is required for internal auth',
        Code.Internal,
      );
    }
    const incomingToken = req.header.get('x-internal-token');
    if (!incomingToken || incomingToken !== expectedToken) {
      throw new ConnectError(
        'Unauthorized: invalid internal token',
        Code.Unauthenticated,
      );
    }
    return await next(req);
  };
}

export function createAuthClientInterceptor(
  options: AuthInterceptorOptions,
): Interceptor {
  return (next) => async (req) => {
    const token = options.token;
    if (!token) {
      throw new ConnectError(
        'Client misconfiguration: INTERNAL_AUTH_TOKEN is required for internal client auth',
        Code.FailedPrecondition,
      );
    }
    req.header.set('x-internal-token', token);
    return await next(req);
  };
}
