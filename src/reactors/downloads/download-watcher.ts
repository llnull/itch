import { Watcher } from "../watcher";
import { actions } from "../../actions";

import rootLogger from "../../logger";
const logger = rootLogger.child({ name: "download-watcher" });

import { throttle } from "underscore";
import { BrowserWindow } from "electron";

import performDownload from "./perform-download";

import { getActiveDownload, getFinishedDownloads } from "./getters";

import Context from "../../context";
import { IStore, IDownloadItem } from "../../types";
import { IProgressInfo, isCancelled, isAborted } from "../../types";

import { DB } from "../../db";
import watcherState, {
  IDownloadHandle,
} from "./download-watcher-persistent-state";
import { wipeDownloadFolder, wipeInstallFolder } from "./wipe-download-folder";

async function updateDownloadState(store: IStore, db: DB) {
  const downloadsState = store.getState().downloads;
  if (downloadsState.paused) {
    if (watcherState.current) {
      cancelCurrent();
    }
    await setProgress(store, -1);
    return;
  }

  const activeDownload = getActiveDownload(downloadsState);
  if (activeDownload) {
    await setProgress(store, activeDownload.progress || 0);
    if (
      !watcherState.current ||
      watcherState.current.item.id !== activeDownload.id
    ) {
      let { game, upload } = activeDownload;
      logger.info(
        `New active download: ${game ? game.title : "<unknown game>"} :: ${
          upload ? upload.filename : "<best upload>"
        }`
      );
      start(store, db, activeDownload);
    } else {
      // still downloading currentDownload
    }
  } else {
    await setProgress(store, -1);
    if (watcherState.current) {
      logger.info("Cancelling last download");
      cancelCurrent();
    } else {
      // idle
    }
  }
}

async function setProgress(store: IStore, alpha: number) {
  const id = store.getState().ui.mainWindow.id;
  if (id) {
    const window = BrowserWindow.fromId(id);
    if (window) {
      window.setProgressBar(alpha);
    }
  }
}

function cancelCurrent() {
  const handle = watcherState.current;

  if (!handle) {
    return;
  }

  if (handle.ctx) {
    logger.info(`Emitting graceful-cancel!`);
    handle.ctx.emit("graceful-cancel", {});
  }

  watcherState.current = null;
}

async function start(store: IStore, db: DB, item: IDownloadItem) {
  cancelCurrent();
  const ctx = new Context(store, db);
  const handle: IDownloadHandle = {
    item,
    ctx,
  };
  watcherState.current = handle;
  watcherState.handles[item.id] = handle;

  let error: Error;
  let interrupted = false;

  try {
    ctx.on(
      "progress",
      throttle((ev: IProgressInfo) => {
        if (interrupted) {
          return;
        }
        store.dispatch(actions.downloadProgress({ id: item.id, ...ev }));
      }, 250)
    );

    logger.info(`Download for ${item.game.title} started`);
    await performDownload(ctx, item);
  } catch (e) {
    logger.debug(`caught exception ${e.stack}`);
    error = e;
  } finally {
    logger.debug(`deleting handle`);
    delete watcherState.handles[item.id];

    let cancelled = isCancelled(error);
    let aborted = isAborted(error);

    if (cancelled || aborted) {
      // no error to handle, but don't trigger downloadEnded either
      interrupted = true;

      if (watcherState.discarded[item.id] || aborted) {
        if (aborted) {
          logger.info(`Download for ${item.game.title} aborted`);
          store.dispatch(actions.downloadDiscarded({ id: item.id }));
        } else {
          logger.info(`Download for ${item.game.title} discarded`);
        }
        delete watcherState.discarded[item.id];
        await cleanupDiscarded(store, db, item);
      } else {
        logger.info(`Download for ${item.game.title} paused/deprioritized`);
      }
    } else {
      logger.info(`Download for ${item.game.title} ended`);
      if (error) {
        logger.error(`Download for ${item.game.title} threw: ${error.stack}`);
      }
      const err = error ? error.message || "" + error : null;
      const errStack = error ? error.stack : null;

      let storeItem = store.getState().downloads.items[item.id];
      let freshItem = storeItem ? storeItem : item;
      store.dispatch(
        actions.downloadEnded({
          id: freshItem.id,
          item: freshItem,
          err,
          errStack,
        })
      );
    }
  }
}

export default function(watcher: Watcher, db: DB) {
  watcher.on(actions.tick, async (store, action) => {
    try {
      await updateDownloadState(store, db);
    } catch (e) {
      logger.error(`While updating download state: ${e.stack || e}`);
    }
  });

  watcher.on(actions.discardDownload, async (store, action) => {
    const { id } = action.payload;

    const item = store.getState().downloads.items[id];
    if (!item) {
      logger.warn(`Trying to discard unknown download ${id}, doing nothing`);
      return;
    }

    if (watcherState.handles[id]) {
      logger.info(`Has handle, marking ${id} as discarded`);
      watcherState.discarded[id] = true;
    } else {
      logger.info(`No handle for ${id}, cleaning up right now`);
      await cleanupDiscarded(store, db, item);
    }
    store.dispatch(actions.downloadDiscarded({ id }));
  });

  watcher.on(actions.clearFinishedDownloads, async (store, action) => {
    const { downloads } = store.getState();
    const finishedDownloads = getFinishedDownloads(downloads);

    // clear all downloads individually, so we have a chance to react to `discardDownload`
    // and gracefully cancel butler / clean up download and install directory
    for (const fd of finishedDownloads) {
      store.dispatch(
        actions.discardDownload({
          id: fd.id,
        })
      );
    }
  });
}

async function cleanupDiscarded(store: IStore, db: DB, item: IDownloadItem) {
  logger.info(`Wiping staging folder for ${item.game.title}`);
  let folderOpts = {
    logger,
    preferences: store.getState().preferences,
    item,
    caveIn: item.caveId ? db.caves.findOneById(item.caveId) : null,
  };
  await wipeDownloadFolder(folderOpts);

  if (item.reason === "install" && item.err) {
    logger.info(`Was fresh install (and had err), wiping install folder too`);
    await wipeInstallFolder(folderOpts);
  }
}
