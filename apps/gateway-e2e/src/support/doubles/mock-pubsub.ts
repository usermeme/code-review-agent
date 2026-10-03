export interface PublishedPubSubMessage {
  topic: string;
  json: any;
  attributes?: Record<string, string>;
}

export class MockPubSub {
  public messages: PublishedPubSubMessage[] = [];

  topic(topicName: string) {
    return {
      publishMessage: async (options: {
        json?: any;
        data?: Buffer;
        attributes?: Record<string, string>;
      }): Promise<string> => {
        let json = options.json;
        if (!json && options.data) {
          try {
            json = JSON.parse(options.data.toString('utf8'));
          } catch {
            json = options.data.toString('utf8');
          }
        }
        this.messages.push({
          topic: topicName,
          json,
          attributes: options.attributes,
        });
        return `mock-msg-${this.messages.length}`;
      },
    };
  }

  getMessagesByTopic(topicName: string): PublishedPubSubMessage[] {
    return this.messages.filter((m) => m.topic === topicName);
  }

  clear(): void {
    this.messages = [];
  }
}
