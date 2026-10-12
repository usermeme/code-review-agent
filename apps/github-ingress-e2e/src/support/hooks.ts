import { After, Before } from '@cucumber/cucumber';

import { GithubIngressWorld } from './world.js';

Before(async function (this: GithubIngressWorld) {
  await this.initApp();
});

After(async function (this: GithubIngressWorld) {
  await this.cleanup();
});
