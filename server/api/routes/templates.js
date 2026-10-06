'use strict';

module.exports = (router, { templates, manager, auth }, { requireAdmin, requireCap }) => {
  router.get('/api/templates', ({ user }) => {
    // People who may create their own servers need the catalogue to pick from.
    if (!auth.can(user, 'deploy')) requireCap(user, 'templates');
    // Tell the UI which games this host can run, and how.
    const list = templates.list().map((t) => {
      let runnable = true;
      let runsAs = null;
      try {
        runsAs = manager.pickPlatform(t);
      } catch (err) {
        runnable = false;
        runsAs = err.message;
      }
      return { ...t, runnable, runsAs };
    });
    return { templates: list, categories: templates.categories() };
  });

  router.get('/api/templates/:id', ({ params }) => ({ template: templates.require(params.id) }));

  /** Live choices for template dropdowns (game versions, build channels…). */
  router.get('/api/options/:source', async ({ params, url }) =>
    require('../../games/options').getOptions(params.source, url.searchParams.get('q') || '', Object.fromEntries(url.searchParams))
  );

  router.post('/api/templates', ({ user, body }) => {
    requireAdmin(user);
    return { template: templates.saveCustom(body) };
  });

  router.delete('/api/templates/:id', ({ user, params }) => {
    requireAdmin(user);
    templates.deleteCustom(params.id);
    return { ok: true };
  });

  router.post('/api/templates/reload', ({ user }) => {
    requireAdmin(user);
    return { count: templates.load() };
  });
};
