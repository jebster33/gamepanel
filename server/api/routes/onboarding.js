'use strict';

const onboarding = require('../../features/onboarding');

// Per-account getting-started checklist (see features/onboarding.js). Every
// signed-in account reads and changes only its own progress.
module.exports = (router, app) => {
  router.get('/api/onboarding', ({ user }) => onboarding.view(app, user));
  router.put('/api/onboarding', ({ user, body }) => onboarding.update(app, user, body || {}));
  router.post('/api/onboarding/reset', ({ user }) => onboarding.reset(app, user));
};
