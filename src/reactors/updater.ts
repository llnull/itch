
import {Watcher} from "./watcher";

import {EventEmitter} from "events";
import * as humanize from "humanize-plus";

import delay from "./delay";

import * as actions from "../actions";

import fetch from "../util/fetch";
import * as paths from "../os/paths";
import api from "../api";

import {makeLogger} from "../logger";
const logger = makeLogger(paths.updaterLogPath());

import {findWhere, filter} from "underscore";

const DELAY_BETWEEN_GAMES = 25;

// 30 minutes * 60 = seconds, * 1000 = millis
const DELAY_BETWEEN_PASSES = 20 * 60 * 1000;
const DELAY_BETWEEN_PASSES_WIGGLE = 10 * 60 * 1000;

import findUpload from "../tasks/find-upload";
import findUpgradePath from "../tasks/find-upgrade-path";

import * as moment from "moment-timezone";

import {
  IStore,
  IGameRecord,
  ICaveRecord,
  IDownloadKey,
} from "../types";

interface IUpdateCheckResult {
  /** set if an error occured while looking for a new version of a game */
  err?: Error;

  /** might be null if an error happened */
  game?: IGameRecord;

  /** true if the game has an upgrade that can be installed */
  hasUpgrade?: boolean;
}

interface IUpdateCheckOpts {
  noisy?: boolean;
}

async function _doCheckForGameUpdate (store: IStore, cave: ICaveRecord, inTaskOpts = {} as IUpdateCheckOpts,
    ): Promise<IUpdateCheckResult> {
  const {noisy = false} = inTaskOpts;
  const returnVars = {} as IUpdateCheckResult;

  const state = store.getState();
  const credentials = state.session.credentials;

  const {installedBy} = cave;
  const {me} = credentials;
  if (installedBy && me) {
    if (installedBy.id !== me.id) {
      logger.warn(`${cave.id} was installed by ${installedBy.username}, we're ${me.username}, skipping check`);
      return {hasUpgrade: false};
    }
  }

  if (!cave.launchable) {
    logger.warn(`Cave isn't launchable, skipping: ${cave.id}`);
    return {hasUpgrade: false};
  }

  if (!cave.gameId) {
    logger.warn(`Cave lacks gameId, skipping: ${cave.id}`);
    return {hasUpgrade: false};
  }

  const market = getUserMarket();
  let game: IGameRecord;
  try {
    game = await fetch.gameLazily(market, credentials, cave.gameId);
  } catch (e) {
    logger.error(`Could not fetch game for ${cave.gameId}, skipping (${e.message || e})`);
    return {err: e};
  }
  returnVars.game = game;
  returnVars.hasUpgrade = false;

  if (!game) {
    logger.warn(`Can't check for updates for ${game.title}, not visible by current user?`);
    return returnVars;
  }

  const tasksForGame = state.tasks.tasksByGameId[game.id];
  if (tasksForGame) {
    for (const task of tasksForGame) {
      if (task.name === "launch") {
        // TODO: don't need to skip the check, just the apply
        logger.warn(`Game ${game.title} is running, skipping update check`);
        return returnVars;
      }
    }
  }

  logger.info(`Looking for updates to ${game.title}...`);

  const out = new EventEmitter();
  const findKey = () => findWhere(market.getEntities<IDownloadKey>("downloadKeys"), {gameId: game.id});
  const taskOpts = {
    logger,
    game,
    gameId: game.id,
    credentials,
    downloadKey: cave.downloadKey || findKey(),
    market,
  };

  try {
    const {uploads, downloadKey} = await findUpload(out, taskOpts);

    if (uploads.length === 0) {
      logger.error(`Can't check for updates for ${game.title}, no uploads.`);
      return {err: new Error("No uploads found")};
    }

    // needed because moment.tz(undefined, "UTC") gives.. the current date!
    // cf. https://github.com/itchio/itch/issues/977
    const installedAtTimestamp = cave.installedAt || 0;

    let installedAt = moment.tz(installedAtTimestamp, "UTC");
    logger.info(`installed at ${installedAt.format()}`);
    if (!installedAt.isValid()) {
      installedAt = moment.tz(0, "UTC");
    }
    const recentUploads = filter(uploads, (upload) => {
      const updatedAt = moment.tz(upload.updatedAt, "UTC");
      const isRecent = updatedAt > installedAt;
      if (!isRecent) {
        logger.info(`Filtering out ${upload.filename} (#${upload.id})` +
          `, ${updatedAt.format()} is older than ${installedAt.format()}`);
      }
      return isRecent;
    });
    logger.info(`${uploads.length} available uploads, ${recentUploads.length} are more recent`);

    let hasUpgrade = false;

    if (cave.uploadId && cave.buildId) {
      logger.info(`Looking for new builds of ${game.title}, from build ${cave.buildId} (upload ${cave.uploadId})`);
      const upload = findWhere(uploads, {id: cave.uploadId});
      if (!upload || !upload.buildId) {
        logger.warn("Uh oh, our wharf-enabled upload disappeared");
      } else {
        if (upload.buildId !== cave.buildId) {
          logger.info(`Got new build available: ${upload.buildId} > ${cave.buildId}`);
          if (noisy) {
            store.dispatch(actions.statusMessage({
              message: ["status.game_update.found", {title: game.title}],
            }));
          }

          hasUpgrade = true;

          const upgradeOpts = {
            ...taskOpts,
            upload,
            gameId: game.id,
            currentBuildId: cave.buildId,
          };
          try {
            const {upgradePath, totalSize} = await findUpgradePath(out, upgradeOpts);
            logger.info(`Got ${upgradePath.length} patches to download, ${humanize.fileSize(totalSize)} total`);

            store.dispatch(actions.gameUpdateAvailable({
              caveId: cave.id,
              update: {
                game,
                recentUploads: [upload],
                downloadKey,
                incremental: true,
                upgradePath,
              },
            }));

            return {...returnVars, hasUpgrade};
          } catch (e) {
            logger.error(`While getting upgrade path: ${e.message || e}`);
            return {err: e.message};
          }
        } else {
          logger.info(`Newest upload has same buildId ${upload.buildId}, disregarding`);
          return returnVars;
        }
      }
    }

    if (recentUploads.length === 0) {
      logger.info(`No recent uploads for ${game.title}, update check done`);
      return returnVars;
    }

    if (recentUploads.length > 1) {
      logger.info("Multiple recent uploads, asking user to pick");

      store.dispatch(actions.gameUpdateAvailable({
        caveId: cave.id,
        update: {
          game,
          recentUploads,
          downloadKey,
        },
      }));

      return {...returnVars, hasUpgrade: true};
    }

    const upload = recentUploads[0];
    const differentUpload = upload.id !== cave.uploadId;
    const wentWharf = upload.buildId && !cave.buildId;

    if (hasUpgrade || differentUpload || wentWharf) {
      logger.info(`Got a new upload for ${game.title}: ${upload.filename}`);
      if (hasUpgrade) {
        logger.info("(Reason: forced)");
      }
      if (differentUpload) {
        logger.info("(Reason: different upload)");
      }
      if (wentWharf) {
        logger.info("(Reason: went wharf)");
      }

      store.dispatch(actions.gameUpdateAvailable({
        caveId: cave.id,
        update: {
          game,
          recentUploads,
          downloadKey,
        },
      }));

      return {...returnVars, hasUpgrade};
    }
  } catch (e) {
    if (api.hasAPIError(e, "incorrect user for claim")) {
      logger.warn(`Skipping update check for ${game.title}, download key belongs to other user`);
    } else if (api.isNetworkError(e)) {
      logger.warn(`Skipping update check for ${game.title}: we're offline`);
      return {err: new Error(`Network error (${e.code})`)};
    } else {
      logger.error(`While looking for update: ${e.stack || e}`);
      logger.error(`Error object: ${JSON.stringify(e, null, 2)}`);
      return {err: e};
    }
  }

  return returnVars;
}

async function doCheckForGameUpdate (store: IStore, cave: ICaveRecord, taskOpts = {} as IUpdateCheckOpts) {
  try {
    return await _doCheckForGameUpdate(store, cave, taskOpts);
  } catch (e) {
    if (e.code && e.code === "ENOTFOUND") {
      logger.warn("Offline, skipping update check");
    } else {
      throw e;
    }
  }
}

let updaterInstalled = false;

export default function (watcher: Watcher) {
  watcher.on(actions.sessionReady, async (store, action) => {
    if (updaterInstalled) {
      return;
    }
    updaterInstalled = true;

    while (true) {
      logger.info("Regularly scheduled check for game updates...");
      store.dispatch(actions.checkForGameUpdates({}));
      await delay(DELAY_BETWEEN_PASSES + Math.random() * DELAY_BETWEEN_PASSES_WIGGLE);
    }
  });

  watcher.on(actions.checkForGameUpdates, async (store, action) => {
    // FIXME: db
    const caves = {};

    for (const caveId of Object.keys(caves)) {
      try {
        await doCheckForGameUpdate(store, caves[caveId]);
      } catch (e) {
        logger.error(`While checking for cave ${caveId} update: ${e.stack || e}`);
      }
      await delay(DELAY_BETWEEN_GAMES);
    }
  });

  watcher.on(actions.checkForGameUpdate, async (store, action) => {
    const {caveId, noisy = false} = action.payload;
    if (noisy) {
      logger.info(`Looking for updates for cave ${caveId}`);
    }

    // FIXME: db
    const cave = null;
    if (!cave) {
      logger.warn(`No cave with id ${caveId}, bailing out`);
      return;
    }

    try {
      const result = await doCheckForGameUpdate(store, cave, {noisy});
      if (noisy) {
        if (result && result.err) {
          store.dispatch(actions.statusMessage({
            message: ["status.game_update.check_failed", {err: result.err}],
          }));
        } else if (result && result.hasUpgrade) {
          if (result.game) {
            store.dispatch(actions.statusMessage({
              message: ["status.game_update.found", {title: result.game.title}],
            }));
          }
        } else if (result && result.game) {
          store.dispatch(actions.statusMessage({
            message: ["status.game_update.not_found", {title: result.game.title}],
          }));
        }
      }
    } catch (e) {
      logger.error(`While checking for cave ${caveId} update: ${e.stack || e}`);
      if (noisy) {
        store.dispatch(actions.statusMessage({
          message: ["status.game_update.check_failed", {err: e}],
        }));
      }
    } finally {
      if (noisy) {
        logger.info(`Done looking for updates for cave ${caveId}`);
      }
    }
  });
}