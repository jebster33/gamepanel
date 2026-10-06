'use strict';

const { fail } = require('../../core/util');

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

  /** The template builder: check a template and show its install script, without saving. */
  router.post('/api/templates/check', ({ user, body }) => {
    requireAdmin(user);
    return require('../../games/template-builder').check(body?.template, templates);
  });

  router.post('/api/templates', ({ user, body }) => {
    requireAdmin(user);
    // The builder sends { template, replace }; older callers send the template itself.
    const input = body?.template && typeof body.template === 'object' ? body.template : body;
    const { template, errors } = require('../../games/template-builder').check(input, templates);
    if (errors.length) fail(400, errors[0]);
    if (templates.get(template.id) && !(body?.replace === template.id)) fail(409, `There is already a game with the id ${template.id}. Pick another id.`);
    return { template: templates.saveCustom(template) };
  });

  /** A custom template's file as it is saved, for the builder to edit. */
  router.get('/api/templates/:id/source', ({ user, params }) => {
    requireAdmin(user);
    const tpl = templates.require(params.id);
    const { custom, ...rest } = tpl;
    return { template: rest, custom: Boolean(custom) };
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
