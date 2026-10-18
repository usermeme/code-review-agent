export interface PublishedPubSubMessage {
  topic: string;
  json: Record<string, unknown>;
}

export class MockPubSub {
  public messages: PublishedPubSubMessage[] = [];

  topic(topicName: string) {
    return {
      publishMessage: async (options: {
        json?: Record<string, unknown>;
      }): Promise<string> => {
        this.messages.push({
          topic: topicName,
          json: options.json ?? {},
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
