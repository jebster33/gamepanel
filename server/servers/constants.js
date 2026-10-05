'use strict';

/** Lifecycle states a server moves through. */
const STATUS = {
  OFFLINE: 'offline',
  INSTALLING: 'installing',
  INSTALL_FAILED: 'install_failed',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  CRASHED: 'crashed',
};

/** Inside a container every server lives here, whatever the host path is. */
const CONTAINER_DIR = '/home/container';

/** How long a server gets to shut down cleanly before it is killed. */
const STOP_GRACE_MS = 45_000;

/** Crashes inside this window count towards the auto-restart limit. */
const CRASH_WINDOW_MS = 10 * 60_000;

module.exports = { STATUS, CONTAINER_DIR, STOP_GRACE_MS, CRASH_WINDOW_MS };
