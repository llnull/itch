import getInstallerType from "./get-installer-type";

import { ICave } from "../../db/models/cave";

import Context from "../../context";

import { Logger } from "../../logger";

import { Cancelled, InstallerType, IRuntime, InstallReason } from "../../types";

import { IReceipt, readReceipt } from "./receipt";

import * as actions from "../../actions";

import urls from "../../constants/urls";
import uuid from "../../util/uuid";

import { Instance, messages } from "node-buse";

export interface ICoreOpts {
  /** for cancellations, accessing db, etc. */
  ctx: Context;

  /** usually goes to a cave logger */
  logger: Logger;

  /** which runtime to install for */
  runtime: IRuntime;

  /** where to install the item */
  destPath: string;

  /** the game we're installing/uninstalling */
  game: Game;

  /** the upload we're installing from */
  upload: Upload;

  /** the build we're installing */
  build?: Build;
}

export interface IInstallOpts extends ICoreOpts {
  /** from what source to install the item */
  downloadFolderPath: string;

  /** from what source to install the item */
  archivePath: string;

  /** the reason or rather action we're doing (fresh install, re-install etc.) */
  reason: InstallReason;

  /** The existing cave object, if any */
  caveIn?: ICave;
}

export interface IUninstallOpts extends ICoreOpts {
  // the cave to uninstall
  cave: ICave;

  // the receipt at the time the uninstall was started, if any
  receiptIn?: IReceipt;
}

export interface IInstallResult {
  files: string[];
  caveOut?: Partial<ICave>;
  receiptOut?: Partial<IReceipt>;
}

export interface IUninstallResult {
  // nothing for now
}

export interface IInstallManager {
  install: (opts: IInstallOpts) => Promise<IInstallResult>;
  uninstall: (opts: IUninstallOpts) => Promise<IUninstallResult>;
}

interface IInstallManagers {
  [key: string]: IInstallManager;
}

import naked from "../naked";
import archive from "../archive";
import msi from "../msi";
import dmg from "../dmg";
import nsis from "../nsis";
import inno from "../inno";
import getGameCredentials from "../../reactors/downloads/get-game-credentials";
import configure from "../../reactors/launch/configure";
import { Game, Build, Upload } from "ts-itchio-api";

const managers: IInstallManagers = {
  naked,
  archive,
  msi,
  dmg,
  nsis,
  inno,
};

interface IPrepareResult {
  source: string;
  installerName: InstallerType;
  manager: IInstallManager;
  receipt: IReceipt;
}

interface IPrepareOpts {
  forceSniff?: boolean;
  specifiedInstallerName?: InstallerType;
}

export async function coreInstall(opts: IInstallOpts): Promise<ICave> {
  const { reason, runtime } = opts;
  const logger = opts.logger.child({ name: "install" });

  // TODO: actually pass `build` when we have one - I don't think we do that yet
  const { ctx, game, caveIn } = opts;

  const inPlace = isInPlace(opts);
  let cave: ICave;

  const taskId = uuid();

  if (inPlace) {
    cave = caveIn;
  } else {
    const credentials = await getGameCredentials(ctx, game);

    const instance = new Instance();
    instance.onClient(async client => {
      try {
        client.onNotification(messages.Operation.Progress, ({ params }) => {
          ctx.emitProgress(params);
        });

        client.onNotification(messages.Log, ({ params }) => {
          switch (params.level) {
            case "debug":
              logger.debug(`[butler] ${params.message}`);
              break;
            case "info":
              logger.info(`[butler] ${params.message}`);
              break;
            case "warn":
              logger.warn(`[butler] ${params.message}`);
              break;
            case "error":
              logger.error(`[butler] ${params.message}`);
              break;
            default:
              logger.info(`[butler ${params.level}] ${params.message}`);
              break;
          }
        });

        client.onNotification(messages.TaskStarted, ({ params }) => {
          ctx.store.dispatch(
            actions.downloadStarted({
              id: taskId,
              reason: params.reason as any,
              game: params.game,
              upload: params.upload,
            })
          );
        });

        client.onNotification(messages.TaskEnded, ({ params }) => {
          ctx.store.dispatch(
            actions.downloadEnded({
              id: taskId,
              err: null,
              result: null,
              item: null,
            })
          );
        });

        const res = await client.call(
          messages.Operation.Start({
            stagingFolder: opts.downloadFolderPath,
            operation: "install",
            installParams: {
              game,
              installFolder: opts.destPath,
              credentials: {
                apiKey: credentials.apiKey,
                downloadKey: credentials.downloadKey
                  ? credentials.downloadKey.id
                  : null,
                server: urls.itchioApi,
              },
            },
          })
        );

        logger.info(`final install result:\n${JSON.stringify(res, null, 2)}`);
        const ires = res.installResult;

        cave = {
          ...caveIn,
          installedAt: new Date(),
          channelName: ires.upload.channelName,
          build: ires.build ? ires.build : null,
          upload: ires.upload,
        };

        if (reason !== "install") {
          logger.info(`Not first install (${reason}), clearing verdict`);
          cave.verdict = null;
        }

        logger.info(`Committing game & cave to db`);
        ctx.db.saveOne("games", game.id, game);
        ctx.db.saveOne("caves", cave.id, cave);
      } finally {
        instance.cancel();
      }
    });
    await instance.promise();

    // TODO: move to buse
    logger.info(`Configuring...`);
    await configure(ctx, {
      game,
      cave,
      logger,
      runtime,
    });
  }

  return cave;
}

export async function coreUninstall(opts: IUninstallOpts) {
  const logger = opts.logger.child({ name: "uninstall" });

  const { manager, source, installerName, receipt } = await prepare(opts, {});
  logger.info(`Uninstalling with ${installerName} (${source})`);

  await manager.uninstall({ ...opts, logger, receiptIn: receipt });
}

async function prepare(
  opts: ICoreOpts,
  prepOpts: IPrepareOpts
): Promise<IPrepareResult> {
  const { ctx, logger, runtime } = opts;
  const { specifiedInstallerName, forceSniff } = prepOpts;

  let source = "";
  let installerName: InstallerType;
  const receipt = await readReceipt(opts);

  if (specifiedInstallerName) {
    source = "specified";
    installerName = specifiedInstallerName;
  } else {
    let receipt: IReceipt;

    if (!forceSniff) {
      receipt = await readReceipt(opts);
    }

    if (!forceSniff && receipt && receipt.installerName) {
      installerName = receipt.installerName;
      source = "cached";
    } else {
      let installOpts = (opts as any) as IInstallOpts;
      if (installOpts.archivePath) {
        installerName = await getInstallerType({
          ctx,
          logger,
          target: installOpts.archivePath,
          runtime,
        });
        source = "sniffed";
      } else {
        logger.info(
          `Doesn't have archive path, doesn't have cached, defaulting to 'archive'`
        );
        installerName = "archive";
        source = "fallback";
      }
    }
  }

  logger.info(`using ${source} installer '${installerName}'`);

  const manager = managers[installerName];
  if (!manager) {
    logger.error(`No install manager found for '${installerName}'`);
    throw new Cancelled("no install manager found");
  }

  return { source, installerName, manager, receipt };
}

interface IInPlaceOpts {
  reason: InstallReason;
}

export function isInPlace(opts: IInPlaceOpts): boolean {
  const { reason } = opts;
  return reason === "heal" || reason === "revert";
}