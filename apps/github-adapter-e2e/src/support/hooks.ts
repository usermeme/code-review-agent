import { Before, After } from '@cucumber/cucumber';
import { GithubAdapterWorld } from './world.js';

Before(async function (this: GithubAdapterWorld) {
  await this.initApp();
});

After(async function (this: GithubAdapterWorld) {
  await this.cleanup();
});
