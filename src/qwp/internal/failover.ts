import {
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpFailoverAttempt,
  QwpFailoverError,
  QwpUpgradeError,
} from "../transport";

/** Creates a stateful endpoint walker that rotates away from the last success. */
export function createQwpFailoverConnectionFactory(
  preferredUrl: string | URL,
  failoverUrls: readonly (string | URL)[] | undefined,
  connect: (endpoint: string | URL) => Promise<QwpBinaryConnection>,
): QwpConnectionFactory {
  const endpoints = [preferredUrl, ...(failoverUrls ?? [])];
  let nextStart = 0;

  return async (): Promise<QwpBinaryConnection> => {
    const attempts: QwpFailoverAttempt[] = [];
    const start = nextStart;
    for (let offset = 0; offset < endpoints.length; offset++) {
      const index = (start + offset) % endpoints.length;
      const endpoint = endpoints[index];
      try {
        const connection = await connect(endpoint);
        nextStart = (index + 1) % endpoints.length;
        return connection;
      } catch (error) {
        attempts.push({ endpoint, error });
        if (error instanceof QwpUpgradeError && !error.tryNextEndpoint) {
          throw error;
        }
      }
    }
    if (attempts.length === 1) throw attempts[0].error;
    throw new QwpFailoverError(attempts);
  };
}
