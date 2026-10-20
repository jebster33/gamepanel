'use strict';

const { fail } = require('../../core/util');
const prefs = require('../../features/ux-prefs');

/** Each account's own interface preferences (pins, folders, tags, dashboard layout). */
module.exports = (router, { store, auth }) => {
  const record = (user) => auth.users.find((u) => u.id === user.id) || fail(404, 'Account not found');

  router.get('/api/me/prefs', ({ user }) => ({ prefs: prefs.read(record(user)), widgets: prefs.WIDGETS }));

  router.put('/api/me/prefs', ({ user, body }) => {
    const next = prefs.update(record(user), body);
    store.save();
    return { prefs: next, widgets: prefs.WIDGETS };
  });
};
