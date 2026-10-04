import { Before, After } from '@cucumber/cucumber';
import { CoreWorld } from './world.js';

Before(async function (this: CoreWorld) {
  await this.initApp();
});

After(async function (this: CoreWorld) {
  await this.cleanup();
});
