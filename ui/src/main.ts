import('./bootstrap')
  .then((m) => m.bootstrap())
  .catch((err) => console.error(err));
