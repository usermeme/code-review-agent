import { PubSub } from '@google-cloud/pubsub';

export class PubSubService {
  private pubsub: PubSub;

  constructor() {
    this.pubsub = new PubSub();
  }

  async publish(topicName: string, data: object) {
    const topic = this.pubsub.topic(topicName);
    const dataBuffer = Buffer.from(JSON.stringify(data));
    try {
      const messageId = await topic.publishMessage({ data: dataBuffer });
      console.log(`Message ${messageId} published to topic ${topicName}.`);
      return messageId;
    } catch (error) {
      console.error(`Received error while publishing: ${(error as Error).message}`);
      throw error;
    }
  }
}

export const pubSubService = new PubSubService();
