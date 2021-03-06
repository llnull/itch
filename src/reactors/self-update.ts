import { Watcher } from "./watcher";

import { app, autoUpdater } from "electron";
import * as os from "../os";
import spawn from "../os/spawn";
import { request } from "../net/request";
import { isNetworkError } from "../net/errors";
import { t } from "../format";

import delay from "./delay";

import env from "../env";
import urls from "../constants/urls";

import rootLogger, { devNull } from "../logger";
const logger = rootLogger.child({ name: "self-update" });
import { formatDate, DATE_FORMAT } from "../format/datetime";

import { actions } from "../actions";
import { fromDateTimeField } from "../db/datetime-field";
import memoize from "../util/lru-memoize";
import { MinimalContext } from "../context/index";
import { modalWidgets } from "../components/modal-widgets/index";

const linux = os.itchPlatform() === "linux";

let hadErrors = false;

// 2 hours, * 60 = minutes, * 60 = seconds, * 1000 = millis
const UPDATE_INTERVAL = 2 * 60 * 60 * 1000;
const UPDATE_INTERVAL_WIGGLE = 0.2 * 60 * 60 * 1000;

// 5 seconds, * 1000 = millis
const DISMISS_TIME = 5 * 1000;

const CHECK_FOR_SELF_UPDATES =
  env.name === "production" || process.env.UP_TO_SCRATCH === "1";

/**
 * Resolves to true if the command returns 0, resolves to false otherwise
 */
async function runs(command: string, args: string[]): Promise<boolean> {
  try {
    await spawn.assert({
      command,
      args,
      ctx: new MinimalContext(),
      logger: devNull,
    });
    return true;
  } catch (e) {
    /* muffin */
  }
  return false;
}

const augmentedPlatform = memoize(1, async () => {
  let platform = os.platform();
  if (platform === "linux") {
    if (await runs("/usr/bin/rpm", ["-q", "-f", "/usr/bin/rpm"])) {
      platform = "rpm";
    } else if (await runs("/usr/bin/dpkg", ["--search", "/usr/bin/dpkg"])) {
      platform = "deb";
    }
  }
  return platform;
});

async function getFeedURL() {
  const base = urls.updateServers[env.channel];
  const platform = (await augmentedPlatform()) + "_" + os.arch();
  const version = app.getVersion();
  const tagSuffix = env.channel === "canary" ? "-canary" : "";
  return `${base}/update/${platform}/${version}${tagSuffix}`;
}

export default function(watcher: Watcher) {
  watcher.on(actions.firstWindowReady, async (store, action) => {
    if (!CHECK_FOR_SELF_UPDATES) {
      return;
    }

    try {
      autoUpdater.on("error", (err: Error) => {
        hadErrors = true;
        const environmentSetManually = !!process.env.NODE_ENV;
        if (
          /^Could not get code signature/.test(err.message) &&
          (env.name === "development" || environmentSetManually)
        ) {
          // electron-prebuilt isn't signed, we know you can't work Squirrel.mac, don't worry
          logger.info("Ignoring Squirrel.mac complaint");
        } else {
          store.dispatch(actions.selfUpdateError({ message: err.message }));
        }
      });
      logger.info("Installed!");
    } catch (e) {
      logger.error(`While installing: ${e.message}`);
      return;
    }

    const feedUrl = await getFeedURL();
    logger.info(`Update feed: ${feedUrl}`);
    autoUpdater.setFeedURL(feedUrl);

    autoUpdater.on("checking-for-update", () =>
      store.dispatch(actions.checkingForSelfUpdate({}))
    );
    autoUpdater.on(
      "update-downloaded",
      (ev: any, releaseNotes: string, releaseName: string) => {
        logger.info(`update downloaded, release name: '${releaseName}'`);
        logger.info(`release notes: \n'${releaseNotes}'`);
        store.dispatch(actions.selfUpdateDownloaded(releaseName));
      }
    );
  });

  watcher.on(actions.tick, async (store, action) => {
    const { nextSelfUpdateCheck } = store.getState().systemTasks;

    if (Date.now() < nextSelfUpdateCheck) {
      // not our time!
      return;
    }

    const sleepTime = UPDATE_INTERVAL + Math.random() + UPDATE_INTERVAL_WIGGLE;
    store.dispatch(
      actions.scheduleSystemTask({
        nextSelfUpdateCheck: Date.now() + sleepTime,
      })
    );

    store.dispatch(actions.checkForSelfUpdate({}));
  });

  watcher.on(actions.checkForSelfUpdate, async (store, action) => {
    logger.info("Checking...");
    const uri = await getFeedURL();

    try {
      const resp = await request("get", uri, {});

      logger.info(`HTTP GET ${uri}: ${resp.statusCode}`);
      if (resp.statusCode === 200) {
        const downloadSelfUpdates = store.getState().preferences
          .downloadSelfUpdates;

        if (autoUpdater && !hadErrors && downloadSelfUpdates && !linux) {
          store.dispatch(
            actions.selfUpdateAvailable({ spec: resp.body, downloading: true })
          );
          autoUpdater.checkForUpdates();
        } else {
          store.dispatch(
            actions.selfUpdateAvailable({
              spec: resp.body,
              downloading: false,
            })
          );
        }
      } else if (resp.statusCode === 204) {
        store.dispatch(actions.selfUpdateNotAvailable({ uptodate: true }));
        await delay(DISMISS_TIME);
        store.dispatch(actions.dismissStatus({}));
      } else {
        store.dispatch(
          actions.selfUpdateError({
            message: `While trying to reach update server: ${resp.status}`,
          })
        );
      }
    } catch (e) {
      if (isNetworkError(e)) {
        logger.warn(
          "Seems like we have no network connectivity, skipping self-update check"
        );
        store.dispatch(actions.selfUpdateNotAvailable({ uptodate: false }));
      } else {
        logger.error(`Server-side error on HTTP GET ${uri}`);
        store.dispatch(
          actions.selfUpdateError({
            message: `While trying to reach update server: ${e.message || e}`,
          })
        );
      }
    }
  });

  watcher.on(actions.applySelfUpdateRequest, async (store, action) => {
    const i18n = store.getState().i18n;
    const spec = store.getState().selfUpdate.downloaded;
    if (!spec) {
      logger.warn(
        "Asked to apply update, but nothing downloaded? bailing out..."
      );
      return;
    }

    const pubDate = fromDateTimeField(spec.pub_date);

    store.dispatch(
      actions.openModal(
        modalWidgets.naked.make({
          title: ["prompt.self_update_ready.title", { version: spec.name }],
          message: [
            "prompt.self_update_ready.message",
            {
              restart: t(i18n, ["prompt.self_update_ready.action.restart"]),
            },
          ],
          detail: [
            "prompt.self_update_ready.detail",
            {
              notes: spec.notes,
              pubDate: formatDate(pubDate, i18n.lang, DATE_FORMAT),
            },
          ],
          buttons: [
            {
              label: ["prompt.self_update_ready.action.restart"],
              action: actions.applySelfUpdate({}),
              icon: "repeat",
            },
            {
              label: ["prompt.self_update_ready.action.snooze"],
              action: actions.snoozeSelfUpdate({}),
              className: "secondary",
            },
          ],
          widgetParams: null,
        })
      )
    );
  });

  watcher.on(actions.applySelfUpdate, async (store, action) => {
    if (!autoUpdater) {
      logger.warn("not applying self update, got no auto-updater");
      return;
    }

    logger.info("Preparing for restart...");
    store.dispatch(actions.quitAndInstall({}));
  });

  watcher.on(actions.selfUpdateError, async (store, action) => {
    const error = action.payload;
    logger.error(`Self-updater barfed: ${error.message}`);
  });

  watcher.on(actions.showAvailableSelfUpdate, async (store, action) => {
    const spec = store.getState().selfUpdate.available;
    if (!spec) {
      logger.warn("Asked to show available self-update but there wasn't any");
      store.dispatch(actions.dismissStatus({}));
      return;
    }
    const pubDate = new Date(spec.pub_date);
    const lang = store.getState().i18n.lang;

    const messageString = `prompt.self_update.message.${os.itchPlatform()}`;

    store.dispatch(
      actions.openModal(
        modalWidgets.naked.make({
          title: ["prompt.self_update.title", { version: spec.name }],
          message: [messageString],
          detail: [
            "prompt.self_update.detail",
            {
              notes: spec.notes,
              pubDate: formatDate(pubDate, lang, DATE_FORMAT),
            },
          ],
          buttons: [
            {
              label: ["prompt.self_update.action.download"],
              action: [
                actions.openUrl({ url: spec.url }),
                actions.dismissStatus({}),
              ],
              icon: "download",
            },
            {
              label: ["prompt.self_update.action.view"],
              action: [
                actions.openUrl({ url: urls.releasesPage }),
                actions.dismissStatus({}),
              ],
              className: "secondary",
              icon: "earth",
            },
            {
              label: ["prompt.self_update.action.dismiss"],
              action: actions.dismissStatus({}),
              className: "secondary",
            },
          ],
          widgetParams: null,
        })
      )
    );
  });

  watcher.on(actions.viewChangelog, async (store, action) => {
    const updateServer = urls.updateServers[env.channel];
    const uri = `${updateServer}/notes`;
    const resp = await request("get", uri, {});

    store.dispatch(
      actions.openModal(
        modalWidgets.naked.make({
          title: ["menu.help.release_notes"],
          message: "Changelog",
          detail: resp.body,
          widgetParams: null,
        })
      )
    );
  });
}
