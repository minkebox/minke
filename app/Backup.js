const MinkeApp = require('./MinkeApp');
const Database = require('./Database');
const Images = require('./Images');

const VERSION = 1;

const Backups = {

  backup: async function() {
    const backup = {
      version: VERSION,
      config: await Database.getConfig('minke'),
      applications: MinkeApp.getApps().reduce((acc, app) => {
        if (app._image !== Images.MINKE) {
          acc.push(app.toJSON());
        }
        return acc;
      }, [])
    };
    return backup;
  },

  restore: async function(backup) {
    if (backup.version !== VERSION) {
      throw new Error('Backup version not supported');
    }

    // Shutdown the system - we're about to erase
    await MinkeApp.shutdown({});

    // Erase all the apps and system configuration
    await Database.reset();

    // Restore the system configuration
    await Database.saveConfig(backup.config);

    // Restore the apps
    await Promise.all(backup.applications.map(app => {
      return Database.saveApp(app);
    }));

    // Force an immediate restart of Minke to load the new setup
    MinkeApp.getAppById('minke').systemRestart('restore');
  }
}

module.exports = {

  restore: async function(backup) {
    Backups.restore(JSON.parse(backup));
  },

  HTML: async function(ctx) {
    ctx.type = 'text/plain';
    ctx.body = JSON.stringify(await Backups.backup());
  }
}