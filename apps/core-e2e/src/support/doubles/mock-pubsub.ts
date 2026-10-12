export interface PublishedPubSubMessage {
  topic: string;
  json: Record<string, unknown>;
  attributes?: Record<string, string>;
}

export class MockPubSub {
  public messages: PublishedPubSubMessage[] = [];

  topic(topicName: string) {
    return {
      publishMessage: async (options: {
        json?: Record<string, unknown>;
        data?: Buffer;
        attributes?: Record<string, string>;
      }): Promise<string> => {
        let json = options.json;
        if (!json && options.data) {
          try {
            json = JSON.parse(options.data.toString('utf8')) as Record<
              string,
              unknown
            >;
          } catch {
            json = { raw: options.data.toString('utf8') };
          }
        }
        this.messages.push({
          topic: topicName,
          json: json ?? {},
          attributes: options.attributes,
        });
        return `mock-msg-${this.messages.length}`;
      },
    };
  }

  getMessagesByTopic(topicName: string): PublishedPubSubMessage[] {
    return this.messages.filter((m) => m.topic === topicName);
  }

  subscription() {
    return {
      on: () => {},
      close: async () => {},
    };
  }

  clear(): void {
    this.messages = [];
  }
}
