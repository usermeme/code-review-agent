import { Before, After } from '@cucumber/cucumber';
import { GatewayWorld } from './world.js';

Before(async function (this: GatewayWorld) {
  await this.initApp();
});

After(async function (this: GatewayWorld) {
  await this.cleanup();
});
