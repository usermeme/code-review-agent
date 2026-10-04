import { Before, After } from '@cucumber/cucumber';
import { GithubGatewayWorld } from './world.js';

Before(async function (this: GithubGatewayWorld) {
  await this.initApp();
});

After(async function (this: GithubGatewayWorld) {
  await this.cleanup();
});
