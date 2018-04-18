const _ = require('lodash');
const path = require('path');
const MiaJs = require('../../../index');
const Logger = MiaJs.Logger;
const Shared = MiaJs.Shared;
const CronJobManagerJob = Shared.cronModules('generic-cronJobManagerJob');

/**
 * Webpack plugin to handle hot module replacement with mia-js-core
 * @param {Object} options
 * @constructor
 */
function HotMia(options) {
    this.config = {};
    this.changedFiles = [];
    this.hmrFiles = [];
    this.startTime = Date.now();
    this.prevTimestamps = new Map();
    this.pathConfig = Shared.config('system.path.modules');
    this.basePath = options.basePath;
    this.mappingsFilePath = options.mappingsFilePath;
    this.reInitRoutes = false;
    this.counter = 0;
    this.modules = {};

    /**
     * Handle reinitialization of express routes
     */
    setInterval(function () {
        this.counter += 1;
        if (this.counter === 1 && this.reInitRoutes) {
            MiaJs.Run.reInitRoutes();
            this.reInitRoutes = false;
        }
    }.bind(this), options.reInitRoutesInterval || 1000);

    /**
     * Recursive function
     * @param {String} filePath
     * @param {Object} dependencies
     * @param {Array} path
     * @return {boolean}
     */
    this.getIdentityPath = function (filePath, dependencies, path) {
        for (let key in dependencies) {
            if (!dependencies.hasOwnProperty(key)) continue;
            let value = dependencies[key];
            path.push(key);
            if (_.isString(value) && value === filePath) {
                return true;
            } else if (_.isObject(value)) {
                if (this.getIdentityPath(filePath, value, path)) return true;
            }
            path.pop();
        }
    };

    /**
     * @param {String} filePath
     * @param {Object} dependencies
     * @return {Array}
     */
    this.getIdentity = function (filePath, dependencies) {
        let path = [];
        this.getIdentityPath(filePath, dependencies, path);
        return path;
    };

    /**
     * Set variables to trigger reinitialization of express routes
     */
    this.reInitializeRoutes = function () {
        this.reInitRoutes = true;
        this.counter = 0;
    };

    /**
     * Do the actual module replacement
     * @param {String} filePath
     */
    this.hotModuleReplacement = function (filePath) {

        const dependenciesMappings = require(this.mappingsFilePath);

        // Invalidate module cache
        delete(require.cache[filePath]);

        if (filePath.indexOf('/' + this.pathConfig.config + '/') !== -1) {
            let identity = this.getIdentity(filePath, dependenciesMappings['config']);
            // We don't need the version here
            identity.pop();
            const config = require(filePath);
            Shared.setConfig(identity, config);
            Logger.info(`[HMR] Replaced config module with identity "${identity.join(',')}"`);

        } else if (filePath.indexOf('/' + this.pathConfig.init + '/') !== -1) {
            let identity = this.getIdentity(filePath, dependenciesMappings['init']);
            // We don't need the version here
            identity.pop();
            const init = require(filePath);
            Shared.setInit(identity, init);
            Logger.info(`[HMR] Replaced init module with identity "${identity.join(',')}"`);

        } else if (filePath.indexOf('/' + this.pathConfig.routes + '/') !== -1) {
            let identity = this.getIdentity(filePath, dependenciesMappings['routesConfig']);
            // We don't need the version here
            identity.pop();
            const routes = require(filePath);
            Shared.setRoutesConfig(identity, routes);
            Logger.info(`[HMR] Replaced routes module with identity "${identity.join(',')}"`);

            this.reInitializeRoutes();

        } else if (filePath.indexOf('/' + this.pathConfig.models + '/') !== -1) {
            const identity = this.getIdentity(filePath, dependenciesMappings['models']);
            const model = require(filePath);
            Shared.setModel(identity, model);
            Logger.info(`[HMR] Replaced model module with identity "${identity.join(',')}"`);

        } else if (filePath.indexOf('/' + this.pathConfig.libs + '/') !== -1) {
            const identity = this.getIdentity(filePath, dependenciesMappings['libs']);
            const lib = require(filePath);
            Shared.setLib(identity, lib);
            Logger.info(`[HMR] Replaced lib module with identity "${identity.join(',')}"`);

        } else if (filePath.indexOf('/' + this.pathConfig.controllers + '/') !== -1) {
            const identity = this.getIdentity(filePath, dependenciesMappings['controllers']);
            const controller = require(filePath);
            Shared.setController(identity, controller);
            Logger.info(`[HMR] Replaced controller module with identity "${identity.join(',')}"`);

            this.reInitializeRoutes();

        } else if (filePath.indexOf('/' + this.pathConfig.crons + '/') !== -1) {
            let identity = this.getIdentity(filePath, dependenciesMappings['cronModules']);
            // We don't need the version here
            identity.pop();
            // Get old cronjob and stop it
            Shared.cronModules(identity).stop();

            // Get, set and start new cronjob
            const cron = require(filePath);
            Shared.setCronModule(identity, cron);
            Logger.info(`[HMR] Replaced cron module with identity "${identity.join(',')}"`);

            cron.initializeJob(CronJobManagerJob.getUniqueServerId());
        }
    };

    /**
     * Bubble up module tree to get all the dependencies of changed files
     * @param {String} filePath
     */
    this.propagateModuleTree = function (filePath) {
        let modules = this.modules.filter(function (module) {
            return module.identifier.indexOf(filePath) !== -1;
        });
        if (modules.length) {
            let module = modules.pop();

            if (module.reasons.length) {
                module.reasons.forEach(function (reason) {
                    let reasonFilePath = path.join(this.basePath, reason.module);
                    // Add file only once and skip files in output path
                    if (this.hmrFiles.indexOf(reasonFilePath) === -1 && reasonFilePath.indexOf(this.config.output.path) === -1) {
                        this.hmrFiles.push(reasonFilePath);
                        this.propagateModuleTree(reasonFilePath);
                    }
                }.bind(this));
            }
        }
    }
}

HotMia.prototype.apply = function (compiler) {
    this.config = compiler.options;

    /**
     * Hook into watch run
     */
    compiler.hooks.watchRun.tap('HotMia', function (compilation) {
        this.changedFiles = [...compilation.fileTimestamps.keys()].filter(function (watchfile) {
            // Skip files in output path
            if (watchfile.indexOf(this.config.output.path) !== -1) return false;
            return (this.prevTimestamps.get(watchfile) || this.startTime) < (compilation.fileTimestamps.get(watchfile) || Infinity);
        }.bind(this));

        this.prevTimestamps = compilation.fileTimestamps;
        this.hmrFiles = this.changedFiles;
    }.bind(this));

    /**
     * Execute when compilation was done successfully
     */
    compiler.hooks.done.tap('HotMia', function (stats) {
        this.modules = stats.toJson({modules: true}).modules;

        this.hmrFiles.forEach(function (filePath) {
            this.propagateModuleTree(filePath);
        }.bind(this));

        this.hmrFiles.forEach(function (filePath) {
            this.hotModuleReplacement(filePath);
        }.bind(this));
    }.bind(this));
};

module.exports = HotMia;