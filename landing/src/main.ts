import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { initFirebase } from './app/firebase/init-firebase';

bootstrapApplication(App, appConfig)
  .then(() => initFirebase())
  .catch((err) => console.error(err));
